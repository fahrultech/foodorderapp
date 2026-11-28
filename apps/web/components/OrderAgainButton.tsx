'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ApiError, api, formatPrice, isApiDown } from '@/lib/api';
import type { BuyAgainPlan, Order, Restaurant } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import {
  planOrderAgain,
  type OrderAgainPlan,
  type OrderAgainSkipReason,
} from '@/lib/order-again';
import { fallbackMessage } from '@/lib/locale-strings';

interface Props {
  /** A COMPLETED or CANCELLED order (session 127 widened the gate — the
   *  ladder never reads money/status fields). Only `id`, `code`,
   *  `contactEmail`, `restaurant.{id,name}` and the frozen `items` rows
   *  (menuItemId + optionSelections) are read — safe to pass the plain
   *  JSON the pages already hold (works from a server component). */
  order: Order;
  /** History cards use the compact pill; the receipt gets the block button. */
  variant?: 'pill' | 'block';
}

type Status = 'idle' | 'working' | 'replace' | 'result' | 'routed';

/** The restaurant facts both plan sources provide (GET /restaurants/:id
 *  structurally satisfies it; the server plan reports it inline). */
type HeldRestaurant = Pick<Restaurant, 'id' | 'minOrderCents'> & { name: string | null };

interface Held {
  plan: OrderAgainPlan;
  restaurant: HeldRestaurant;
  /** Set once the cart was written; drives the below-minimum honesty line. */
  projectedSubtotalCents: number | null;
  /** Riding lines whose CURRENT unit price differs from the snapshot.
   *  Only the SERVER plan can report these; the client fallback leaves []. */
  drifted: Array<{ name: string; deltaCents: number }>;
}

const SKIP_KEY: Record<OrderAgainSkipReason, string> = {
  gone: 'skipGone',
  unavailable: 'skipUnavailable',
  'sold-out': 'skipSoldOut',
  'options-changed': 'skipOptionsChanged',
};

/** Map the wire plan onto the ladder shape the panels/cart already consume. */
function fromServerPlan(p: BuyAgainPlan): OrderAgainPlan {
  return {
    lines: p.lines.map((l) => ({
      item: l.dish,
      options: l.options,
      quantity: l.quantity,
      requestedQuantity: l.requestedQuantity,
    })),
    skipped: p.skipped,
    clamped: p.clamped,
    addedUnits: p.addedUnits,
    plannedSubtotalCents: p.plannedSubtotalCents,
  };
}

/**
 * "Order again" (Phase 10, session 107; server rung in Phase 17, session 149):
 * one click rebuilds the cart from a completed order's FROZEN snapshot. The
 * CURRENT authority is `GET /orders/:id/buy-again-plan` — the same receipt
 * ladder revalidated SERVER-side against the live menu (gone dishes, price
 * deltas, option legality, stock). When that read is unavailable (API down,
 * a legacy order with no unlock proof for this door) the session-107 client
 * ladder in `lib/order-again.ts` runs against the public menu read instead —
 * rung-for-rung identical on WHICH lines ride, minus the drift report.
 * Deleted or hidden dishes and drifted option selections are SKIPPED AND
 * REPORTED, never silently swapped. A plan that is fully honest-clean (no
 * skips, no stock clamp, no price drift, no below-minimum) routes straight
 * to the restaurant page; anything worth telling keeps the shopper here with
 * a result panel and an explicit "Go to ..." link. A cart holding another
 * restaurant's dishes always goes through the inline replace confirmation
 * first — the same never-silently-discard rule as the single-item
 * CartSwitchDialog.
 */
export default function OrderAgainButton({ order, variant = 'pill' }: Props) {
  const t = useTranslations('OrderAgain');
  const c = useTranslations('Common');
  const router = useRouter();
  const { getAccessToken } = useAuth();
  const { lines, restaurantId: cartRestaurantId, restaurantName: cartRestaurantName, subtotalCents, applyOrderAgain } = useCart();

  const [status, setStatus] = useState<Status>('idle');
  const [held, setHeld] = useState<Held | null>(null);
  const [error, setError] = useState<string | null>(null);

  const restaurantInfo = order.restaurant;

  function applyAndSettle(
    plan: OrderAgainPlan,
    restaurant: HeldRestaurant,
    mode: 'merge' | 'replace',
    cartSubtotal: number,
    drifted: Held['drifted'],
  ) {
    applyOrderAgain(
      { id: restaurant.id, name: restaurant.name ?? '' },
      plan.lines.map(({ item, options, quantity }) => ({ item, options, quantity })),
      mode,
    );
    const projected =
      mode === 'merge' ? cartSubtotal + plan.plannedSubtotalCents : plan.plannedSubtotalCents;
    const belowMin = projected < restaurant.minOrderCents;
    const clean =
      plan.skipped.length === 0 && plan.clamped.length === 0 && drifted.length === 0 && !belowMin;
    if (clean) {
      setStatus('routed');
      router.push(`/restaurants/${restaurant.id}`);
      return;
    }
    setHeld({ plan, restaurant, projectedSubtotalCents: projected, drifted });
    setStatus('result');
  }

  async function onClick() {
    if (!restaurantInfo?.id) return;
    setStatus('working');
    setError(null);
    const cartSnapshot = { subtotalCents, mode: (lines.length > 0 && cartRestaurantId !== restaurantInfo.id ? 'foreign' : 'same') as 'foreign' | 'same' };
    try {
      // Server rung FIRST (session 149): the receipt-ladder-authenticated
      // plan with price drift. Any failure (404 without a proof this door
      // can present, transport error, malformed shape) falls back to the
      // session-107 client ladder — never a dead button.
      let plan: OrderAgainPlan;
      let restaurant: HeldRestaurant;
      let drifted: Held['drifted'] = [];
      try {
        const token = await getAccessToken();
        const serverPlan = await api.getBuyAgainPlan(order.id, {
          accessToken: token ?? undefined,
          contactEmail: order.contactEmail ?? undefined,
        });
        plan = fromServerPlan(serverPlan);
        restaurant = {
          id: serverPlan.restaurant.id ?? restaurantInfo.id,
          name: serverPlan.restaurant.name ?? restaurantInfo.name ?? null,
          minOrderCents: serverPlan.restaurant.minOrderCents,
        };
        drifted = serverPlan.lines
          .filter((l) => l.priceDeltaCents !== 0)
          .map((l) => ({ name: l.dish.name, deltaCents: l.priceDeltaCents }));
      } catch {
        const current = await api.getRestaurant(restaurantInfo.id);
        restaurant = current;
        plan = planOrderAgain(order, current);
      }
      if (plan.lines.length === 0) {
        // Nothing rides — no cart write, no navigation, just the report.
        setHeld({ plan, restaurant, projectedSubtotalCents: null, drifted });
        setStatus('result');
        return;
      }
      if (cartSnapshot.mode === 'foreign') {
        setHeld({ plan, restaurant, projectedSubtotalCents: null, drifted });
        setStatus('replace');
        return;
      }
      applyAndSettle(plan, restaurant, 'merge', cartSnapshot.subtotalCents, drifted);
    } catch (err) {
      setError(isApiDown(err) ? fallbackMessage('apiDown') : err instanceof ApiError ? err.message : t('errLoad'));
      setStatus('idle');
    }
  }

  function confirmReplace() {
    if (!held) return;
    applyAndSettle(held.plan, held.restaurant, 'replace', 0, held.drifted);
  }

  const button = (
    <button
      onClick={() => void onClick()}
      disabled={status === 'working' || status === 'routed' || !restaurantInfo?.id}
      data-testid={`order-again-${order.code}`}
      className={
        variant === 'block'
          ? 'rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50'
          : 'rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-bold text-stone-700 hover:bg-stone-100 disabled:opacity-50'
      }
    >
      {status === 'working' || status === 'routed' ? t('working') : t('button')}
    </button>
  );

  if (status === 'replace' && held) {
    return (
      <div
        role="group"
        aria-label={t('replaceTitle')}
        className="mt-3 w-full rounded-xl border border-amber-300 bg-amber-50 p-4 text-left"
        data-testid={`order-again-replace-${order.code}`}
      >
        <p className="text-sm font-bold text-amber-900">{t('replaceTitle')}</p>
        <p className="mt-1 text-xs text-amber-800">
          {t('replaceBody', { current: cartRestaurantName ?? '' })}
        </p>
        <p className="mt-2 text-xs font-semibold text-amber-900">{t('newCartLines')}</p>
        <ul className="mt-1 space-y-0.5 text-xs text-amber-800">
          {held.plan.lines.map((l) => (
            <li key={l.item.id + l.options.map((o) => o.choiceId).join(',')} className="flex justify-between gap-3">
              <span>{c('qtyLine', { count: String(l.quantity), name: l.item.name })}</span>
              <span className="font-semibold">
                {formatPrice((l.item.priceCents + l.options.reduce((s, o) => s + o.priceDeltaCents, 0)) * l.quantity)}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={confirmReplace}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-700"
            data-testid="order-again-replace-confirm"
          >
            {t('replaceConfirm')}
          </button>
          <button
            onClick={() => {
              setHeld(null);
              setStatus('idle');
            }}
            className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-bold text-stone-700 hover:bg-stone-100"
            data-testid="order-again-replace-cancel"
          >
            {t('replaceCancel')}
          </button>
        </div>
      </div>
    );
  }

  if (status === 'result' && held) {
    const belowMin =
      held.projectedSubtotalCents !== null &&
      held.projectedSubtotalCents < held.restaurant.minOrderCents;
    return (
      <div
        role="status"
        className="mt-3 w-full rounded-xl border border-stone-200 bg-stone-50 p-4 text-left"
        data-testid={`order-again-result-${order.code}`}
      >
        <p className="text-sm font-bold text-stone-800">
          {held.plan.lines.length === 0
            ? t('nothingAdded')
            : t('addedCount', { count: held.plan.addedUnits })}
        </p>
        {held.plan.skipped.length > 0 && (
          <>
            <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
              {t('skippedHeading')}
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-rose-700">
              {held.plan.skipped.map((s, i) => (
                <li key={`${s.reason}-${i}`} data-testid="order-again-skipped">
                  <span className="font-semibold">{s.name}</span>
                  {' — '}
                  {t(SKIP_KEY[s.reason])}
                </li>
              ))}
            </ul>
          </>
        )}
        {held.plan.clamped.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-amber-700">
            {held.plan.clamped.map((cl, i) => (
              <li key={`${cl.name}-${i}`} data-testid="order-again-clamped">
                {t('clampedNote', { name: cl.name, count: String(cl.to) })}
              </li>
            ))}
          </ul>
        )}
        {held.drifted.length > 0 && (
          <>
            <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
              {t('priceChangedHeading')}
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-sky-700">
              {held.drifted.map((d, i) => (
                <li key={`${d.name}-${i}`} data-testid="order-again-price">
                  {d.deltaCents >= 0
                    ? t('priceUp', { name: d.name, price: formatPrice(d.deltaCents) })
                    : t('priceDown', { name: d.name, price: formatPrice(-d.deltaCents) })}
                </li>
              ))}
            </ul>
          </>
        )}
        {belowMin && (
          <p className="mt-2 text-xs text-amber-700" data-testid="order-again-below-min">
            {t('belowMin', {
              price: formatPrice(held.projectedSubtotalCents!),
              min: formatPrice(held.restaurant.minOrderCents),
            })}
          </p>
        )}
        <Link
          href={`/restaurants/${held.restaurant.id}`}
          data-testid="order-again-continue"
          className="mt-3 inline-block rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold text-white hover:bg-brand-700"
        >
          {t('goToRestaurant', { name: held.restaurant.name ?? restaurantInfo?.name ?? '' })}
        </Link>
      </div>
    );
  }

  return (
    <div className="block w-full">
      {button}
      {error && (
        <p role="alert" className="mt-1 max-w-xs text-xs font-semibold text-rose-700" data-testid={`order-again-error-${order.code}`}>
          {error}
        </p>
      )}
    </div>
  );
}
