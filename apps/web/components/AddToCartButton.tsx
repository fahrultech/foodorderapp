'use client';

import { useMemo, useState } from 'react';
import type { MenuItem, Restaurant } from '@/lib/api';
import { formatPrice } from '@/lib/api';
import { useCart, type CartLineOption } from '@/lib/cart';
import { isSoldOut } from '@/components/StockBadge';
import { useTranslations } from 'next-intl';

interface Props {
  item: MenuItem;
  restaurant: Pick<Restaurant, 'id' | 'name'>;
}

/**
 * "Add" control for one dish. Dishes without option groups render exactly
 * the classic button. Dishes WITH groups render a chip picker (radio when
 * maxChoices is 1, multi-select otherwise) above the button; the button
 * stays labelled "Add" for optional groups — the contract the e2e suite
 * clicks — and only changes label while a MANDATORY group is unmet.
 * Selections are display-side convenience: the server re-validates the ids
 * and prices the line itself at order creation (MenuOptionService).
 */
export default function AddToCartButton({ item, restaurant }: Props) {
  const { add, quantityOf } = useCart();
  const t = useTranslations('CartButton');
  const o = useTranslations('Options');
  const [added, setAdded] = useState(false);
  // groupId -> selected choice ids (kept in click order; ordering for the
  // receipt line happens below in group+position order).
  const [selected, setSelected] = useState<Record<string, string[]>>({});

  const groups = useMemo(() => item.optionGroups ?? [], [item.optionGroups]);
  const hasOptions = groups.length > 0;

  const options = useMemo<CartLineOption[]>(() => {
    if (!hasOptions) return [];
    const rows: CartLineOption[] = [];
    for (const g of groups) {
      const picked = new Set(selected[g.id] ?? []);
      for (const c of g.choices ?? []) {
        if (picked.has(c.id)) {
          rows.push({
            groupId: g.id,
            groupName: g.name,
            choiceId: c.id,
            choiceName: c.name,
            priceDeltaCents: c.priceDeltaCents,
          });
        }
      }
    }
    return rows;
  }, [groups, selected, hasOptions]);

  const deltaCents = options.reduce((s, x) => s + x.priceDeltaCents, 0);
  const unitCents = item.priceCents + deltaCents;
  // First mandatory group the shopper has not satisfied yet — drives the
  // disabled state and the label so the reason is always visible.
  const missingGroup = hasOptions
    ? groups.find((g) => (selected[g.id]?.length ?? 0) < g.minChoices)
    : undefined;
  const inCart = quantityOf(item.id);
  // Session 74: a tracked counter at zero is as un-addable as an unlisted
  // dish — pure UX courtesy on top of the server's 409 INSUFFICIENT_STOCK.
  const soldOut = isSoldOut(item);

  function toggle(groupId: string, choiceId: string, maxChoices: number) {
    setSelected((prev) => {
      const cur = prev[groupId] ?? [];
      if (cur.includes(choiceId)) {
        return { ...prev, [groupId]: cur.filter((x) => x !== choiceId) };
      }
      // Radio group: the new pick replaces the old one (and re-clicking the
      // only checked chip un-checks it — optional groups may stay empty).
      if (maxChoices <= 1) return { ...prev, [groupId]: [choiceId] };
      if (cur.length >= maxChoices) return prev; // defensive; chips are disabled too
      return { ...prev, [groupId]: [...cur, choiceId] };
    });
  }

  function onClick() {
    if (missingGroup) return;
    // 'needs-switch' opens the cart-switch confirmation dialog (see CartSwitchModal) —
    // only flash "Added" when the dish actually entered the cart.
    if (add(item, restaurant, options) === 'added') {
      setAdded(true);
      setTimeout(() => setAdded(false), 900);
    }
  }

  const label = !item.isAvailable
    ? t('unavailable')
    : soldOut
      ? t('soldOut')
      : missingGroup
        ? t('chooseOptions', { name: missingGroup.name })
        : added
          ? t('added')
          : inCart
            ? t('addWithCount', { count: inCart })
            : t('add');

  const addButton = (
    <button
      onClick={onClick}
      disabled={!item.isAvailable || !!missingGroup || soldOut}
      data-testid={soldOut ? 'add-sold-out' : undefined}
      className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-stone-300"
    >
      {label}
    </button>
  );

  if (!hasOptions) return addButton;

  return (
    <div className="mt-3" data-testid={`dish-options-${item.id}`}>
      <div className="space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-3">
        {groups.map((g) => {
          const sel = selected[g.id] ?? [];
          const single = g.maxChoices <= 1;
          return (
            <fieldset key={g.id}>
              <legend className="text-xs font-semibold uppercase tracking-wide text-stone-600">
                {g.name}
                <span className="ml-2 font-normal normal-case text-stone-400">
                  {g.minChoices > 0
                    ? o('required', { count: g.minChoices })
                    : single
                      ? o('chooseOne')
                      : o('upTo', { count: g.maxChoices })}
                </span>
              </legend>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {(g.choices ?? []).map((c) => {
                  const on = sel.includes(c.id);
                  const blocked = !on && !single && sel.length >= g.maxChoices;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={on}
                      disabled={blocked || !item.isAvailable || soldOut}
                      onClick={() => toggle(g.id, c.id, g.maxChoices)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                        on
                          ? 'border-brand-500 bg-brand-50 text-brand-700 ring-2 ring-brand-100'
                          : 'border-stone-300 bg-white text-stone-700 hover:border-brand-400'
                      } disabled:cursor-not-allowed disabled:opacity-40`}
                    >
                      {c.name}
                      {c.priceDeltaCents > 0 && (
                        <span className="ml-1 text-stone-500">+{formatPrice(c.priceDeltaCents)}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-end gap-3">
        {deltaCents > 0 && (
          <p className="text-xs text-stone-500" data-testid="options-unit-price">
            {o('unitPrice', { price: formatPrice(unitCents) })}
          </p>
        )}
        {addButton}
      </div>
    </div>
  );
}
