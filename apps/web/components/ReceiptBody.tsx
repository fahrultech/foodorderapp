'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatPrice, optionRowLabels, type Order } from '@/lib/api';
import { saveCachedOrder } from '@/lib/order-cache';
import OrderTimeline from '@/components/OrderTimeline';
import OrderLiveFeed from '@/components/OrderLiveFeed';
import RateOrderCard from '@/components/RateOrderCard';
import OrderAgainButton from '@/components/OrderAgainButton';
import PaymentPanel from '@/components/PaymentPanel';

/**
 * The receipt body (Phase 15 extraction): the entire successfully-fetched
 * order view, moved verbatim out of `app/orders/[id]/page.tsx` so the SAME
 * render serves both the live SSR path and the offline localStorage restore
 * in `CachedReceiptFallback` (ONE source — inlining a second receipt copy
 * would drift the first time either side edits).
 *
 * The server page passes `persist` on a live read: the effect stores the row
 * per id via `lib/order-cache`, which is what makes a later network-drop
 * recoverable at all. The cached branch renders WITHOUT `persist` — a saved
 * copy must not refresh its own savedAt (the banner's honesty clock).
 *
 * Client-component status is deliberate (localStorage + hooks), NOT a behavior
 * change: App Router still server-renders this tree into the SSR HTML, so the
 * receipt DOM every existing spec pins renders exactly as before.
 */

interface Props {
  order: Order;
  /** checkout handoff code hint (page's legacy `?code=` param gate). */
  codeHint?: string;
  /** `?pay=1` nudge from checkout. */
  payHighlight?: boolean;
  /** `?rt=` magic-link capability, forwarded to the payment panel. */
  receiptToken?: string;
  /** Persist this (live-sourced) row into the offline cache. */
  persist?: boolean;
  /**
   * Offline RESTORE render (Phase 15, CachedReceiptFallback): the three
   * live-API islands — PaymentPanel (payment rows), OrderLiveFeed
   * (SSE/WS/poll) and RateOrderCard (review POSTs) — would fire failing
   * requests against a dead API and paint error cards next to the honest
   * "saved copy" banner. That is the session-91 lie ban from the other
   * side: never dress a network drop up as a data failure. The cached
   * view is a STATIC receipt: header, timeline (pure render of stored
   * timestamps), items/totals, contact block, and OrderAgainButton — the
   * one island that genuinely WORKS offline (cart is localStorage).
   */
  offline?: boolean;
}

export default function ReceiptBody({
  order,
  codeHint,
  payHighlight,
  receiptToken,
  persist,
  offline,
}: Props) {
  const t = useTranslations('Order');
  const c = useTranslations('Common');
  const STATUS_LABEL: Record<string, string> = {
    pending: t('pillPending'),
    confirmed: t('pillConfirmed'),
    preparing: t('pillPreparing'),
    delivering: t('pillDelivering'),
    completed: t('pillCompleted'),
    cancelled: t('pillCancelled'),
  };

  useEffect(() => {
    if (persist) saveCachedOrder(order);
  }, [persist, order]);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center">
        <p className="text-4xl">{order.status === 'cancelled' ? '❌' : '🎉'}</p>
        <h1 className="mt-3 text-2xl font-extrabold">
          {order.status === 'cancelled'
            ? t('cancelledTitle', { code: order.code })
            : t('placedTitle', { code: order.code })}
        </h1>
        <p className="mt-1 text-sm text-stone-500">
          {(codeHint || order.code) && t('reference', { code: order.code })} ·{' '}
          {order.restaurant?.name ?? t('restaurantFallback')}
        </p>
        <p className="mt-4 inline-block rounded-full bg-stone-100 px-4 py-2 text-sm font-semibold">
          {STATUS_LABEL[order.status] ?? order.status}
        </p>
      </div>

      {/* Phase 5: pay-now affordance + payment receipt on the order page.
          ?pay=1 is set by checkout for signed-in customers (finish-payment
          nudge); ?rt= (Phase 15) lets an emailed guest receipt pay its own
          order with no account — the panel rides the same capability.
          Suppressed on the offline restore: it would only answer with a
          failure card about data it cannot fetch. */}
      {!offline && (
        <PaymentPanel
          orderId={order.id}
          orderStatus={order.status}
          totalCents={order.totalCents}
          highlight={payHighlight}
          receiptToken={receiptToken}
        />
      )}

      <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-bold">{t('progressTitle')}</h2>
          {!offline && <OrderLiveFeed orderId={order.id} orderStatus={order.status} />}
        </div>
        <OrderTimeline order={order} />
        {/* Tracking-page delivery polish (session 119): once the order is
            out for delivery, name the driver and show the honest countdown
            derived from session 113's per-restaurant ETA. The API embeds
            `delivery` ONLY on this read and ONLY while `delivering`, so the
            gate here mirrors the wire contract; router.refresh() from the
            live-feed island above re-runs the server fetch, so a status
            flip to `delivering` surfaces this card without a manual reload. */}
        {order.status === 'delivering' && order.delivery && (
          <div
            className="mt-4 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
            data-testid="tracking-delivery"
          >
            {order.delivery.driverFirstName && (
              <p className="font-semibold" data-testid="tracking-delivery-driver">
                {t('deliveryDriver', { name: order.delivery.driverFirstName })}
              </p>
            )}
            <p
              className={`text-stone-500 ${order.delivery.driverFirstName ? 'mt-0.5' : ''}`}
              data-testid="tracking-delivery-eta"
              title={
                order.delivery.etaSource === 'observed'
                  ? t('deliveryEtaObservedTitle', { count: order.delivery.sampleCount })
                  : undefined
              }
            >
              {order.delivery.etaSource === null || order.delivery.remainingMinutes === null
                ? t('deliveryEtaUnknown')
                : order.delivery.remainingMinutes === 0
                  ? t('deliveryEtaSoon')
                  : t('deliveryEtaMinutes', { minutes: String(order.delivery.remainingMinutes) })}
            </p>
          </div>
        )}
      </div>

      {!offline && order.status === 'completed' && (
        <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5">
          <h2 className="font-bold">{t('rateTitle')}</h2>
          <p className="mt-1 text-sm text-stone-500">
            {t('rateBody', { name: order.restaurant?.name ?? t('rateRestaurantFallback') })}
          </p>
          <RateOrderCard orderId={order.id} />
        </div>
      )}

      <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5">
        <h2 className="font-bold">{t('itemsTitle')}</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {order.items.map((i) => (
            <li key={i.id}>
              <div className="flex justify-between">
                <span>{c('qtyLine', { count: String(i.quantity), name: i.name })}</span>
                <span>{formatPrice(i.unitPriceCents * i.quantity)}</span>
              </div>
              {i.optionSelections && i.optionSelections.length > 0 && (
                <p className="mt-0.5 text-xs text-stone-500">
                  {optionRowLabels(i.optionSelections).join(' · ')}
                </p>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-1 border-t border-stone-200 pt-3 text-sm">
          <div className="flex justify-between text-stone-500">
            <span>{c('subtotal')}</span>
            <span>{formatPrice(order.subtotalCents)}</span>
          </div>
          {order.discountCents > 0 && (
            <div className="flex justify-between font-medium text-emerald-600">
              <span>{c('promoLine', { code: order.promoCode ?? '' })}</span>
              <span>-{formatPrice(order.discountCents)}</span>
            </div>
          )}
          <div className="flex justify-between text-stone-500">
            <span>{c('wordDelivery')}</span>
            <span>{formatPrice(order.deliveryFeeCents)}</span>
          </div>
          <div className="flex justify-between text-base font-extrabold">
            <span>{c('total')}</span>
            <span>{formatPrice(order.totalCents)}</span>
          </div>
        </div>
        <div className="mt-4 border-t border-stone-200 pt-3 text-sm text-stone-500">
          <p>
            <strong className="text-stone-700">{t('deliveringTo')}</strong> {order.deliveryAddress}
          </p>
          <p className="mt-1">
            <strong className="text-stone-700">{t('contactLabel')}</strong> {order.customerName} ·{' '}
            {order.contactPhone}
          </p>
          {order.note && (
            <p className="mt-1">
              <strong className="text-stone-700">{t('noteLabel')}</strong> {order.note}
            </p>
          )}
        </div>
      </div>

      <div className="mt-6 text-center">
        <Link href="/" className="text-sm font-semibold text-brand-600 hover:underline">
          {t('orderMore')}
        </Link>
      </div>

      {/* "Order again" (session 107, extended to CANCELLED receipts
          session 127): the receipt mirrors the history-card action for
          COMPLETED and CANCELLED orders. Client island — the cart is
          localStorage-backed, so it works for guests too (checkout already
          supports guest carts). */}
      {(order.status === 'completed' || order.status === 'cancelled') && (
        <div className="mt-2 text-center">
          <OrderAgainButton order={order} variant="block" />
        </div>
      )}
    </div>
  );
}
