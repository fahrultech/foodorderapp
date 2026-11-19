/**
 * "Order again" availability ladder (Phase 10, session 107).
 *
 * Pure function: given an order's FROZEN item rows (name/quantity snapshot +
 * `menuItemId` + the jsonb `optionSelections` receipt) and the CURRENT
 * public restaurant read (`GET /restaurants/:id` embeds every dish in ANY
 * availability with `isAvailable`/`stock`/`optionGroups`), decide exactly
 * which cart lines can honestly be rebuilt and which must be reported as
 * skipped. No React, no fetching — unit-testable and shared by the history
 * card and the receipt island.
 *
 * Ladder per ordered row (first failing rung wins):
 *  1. `menuItemId` null (FK SET NULL after a hard delete) or the dish is not
 *     on the current menu at all   -> 'gone'
 *  2. dish exists but `isAvailable: false` -> 'unavailable'
 *  3. tracked stock at 0            -> 'sold-out'
 *  4. every frozen choiceId must still live in the SAME option group, and
 *     the rebuilt selection must satisfy the CURRENT per-group min/max
 *     (a group added/deleted/priced away since the order cannot be
 *     second-guessed)             -> 'options-changed'
 *  5. tracked stock below the ordered quantity -> the line rides, quantity
 *     CLAMPED to stock and reported in `clamped`.
 *
 * Prices are ALWAYS the current menu's (base + current deltas); the server
 * re-prices from the choice ids at order-create anyway, so a price drift
 * never blocks a re-order — the line's total simply reflects today's menu.
 */
import type { MenuItem, Order, Restaurant } from './api';
import { lineKeyFor, optionsDeltaCents, type CartLineOption } from './cart';

export type OrderAgainSkipReason = 'gone' | 'unavailable' | 'sold-out' | 'options-changed';

/** One rebuilt line: the CURRENT dish, the rebuilt current choice rows and
 *  the quantity (already stock-clamped; `requestedQuantity` is the frozen
 *  one so the UI can honestly say "only N left"). */
export interface OrderAgainLine {
  item: MenuItem;
  options: CartLineOption[];
  quantity: number;
  requestedQuantity: number;
}

export interface OrderAgainPlan {
  /** Lines in the snapshot's row order, duplicates merged by lineKey. */
  lines: OrderAgainLine[];
  /** Snapshot row name + the rung that rejected it. */
  skipped: Array<{ name: string; reason: OrderAgainSkipReason }>;
  /** Lines that rode with a stock-clamped quantity. */
  clamped: Array<{ name: string; from: number; to: number }>;
  /** Units the plan would add to the cart. */
  addedUnits: number;
  /** Subtotal of the planned lines at CURRENT prices (display only). */
  plannedSubtotalCents: number;
}

/** The cart context caps one line at 50 units — the planner pre-applies the
 *  same ceiling so the ladder's clamp report matches what will be stored. */
const LINE_CAP = 50;

function unitPriceCents(dish: MenuItem, options: CartLineOption[]): number {
  return dish.priceCents + optionsDeltaCents(options);
}

function clampQuantity(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  return Math.min(LINE_CAP, Math.max(1, Math.floor(raw)));
}

export function planOrderAgain(order: Order, restaurant: Restaurant): OrderAgainPlan {
  const byId = new Map((restaurant.menuItems ?? []).map((m) => [m.id, m]));
  const lines: OrderAgainLine[] = [];
  const skipped: OrderAgainPlan['skipped'] = [];

  for (const row of order.items ?? []) {
    const name = row.name;
    // Rung 1: dish hard-deleted since the order (FK nulled the id) or the id
    // is simply not on this restaurant's menu any more.
    if (!row.menuItemId) {
      skipped.push({ name, reason: 'gone' });
      continue;
    }
    const dish = byId.get(row.menuItemId);
    if (!dish) {
      skipped.push({ name, reason: 'gone' });
      continue;
    }
    // Rung 2: the owner hid it (draft/unavailable toggle).
    if (!dish.isAvailable) {
      skipped.push({ name, reason: 'unavailable' });
      continue;
    }
    // Rung 3: tracked counter at zero — same courtesy AddToCartButton shows.
    if (dish.stock === 0) {
      skipped.push({ name, reason: 'sold-out' });
      continue;
    }
    // Rung 4: rebuild the option rows from the frozen receipt. Every choice
    // must still exist inside the SAME group; then the selection must still
    // satisfy the group's CURRENT min/max. Anything else we would be
    // guessing at the customer's intent — skip and report instead.
    const groups = dish.optionGroups ?? [];
    const snapshot = row.optionSelections ?? [];
    const options: CartLineOption[] = [];
    let optionsBroken = false;
    const seen = new Set<string>();
    for (const s of snapshot) {
      if (seen.has(s.choiceId)) continue; // defensive: receipt never repeats a choice
      seen.add(s.choiceId);
      const group = groups.find((g) => g.id === s.groupId);
      const choice = group?.choices?.find((c) => c.id === s.choiceId);
      if (!group || !choice) {
        optionsBroken = true;
        break;
      }
      options.push({
        groupId: group.id,
        groupName: group.name,
        choiceId: choice.id,
        choiceName: choice.name,
        priceDeltaCents: choice.priceDeltaCents,
      });
    }
    if (!optionsBroken) {
      for (const g of groups) {
        const picked = options.filter((o) => o.groupId === g.id).length;
        if (picked < g.minChoices || picked > g.maxChoices) {
          optionsBroken = true;
          break;
        }
      }
    }
    if (optionsBroken) {
      skipped.push({ name, reason: 'options-changed' });
      continue;
    }

    const requestedQuantity = clampQuantity(row.quantity);
    // Merge same dish + same selection rows (order create allows duplicates;
    // the cart keys lines by dish+choiceIds and would otherwise collide).
    const key = lineKeyFor(dish.id, options);
    const existing = lines.find(
      (l) => l.item.id === dish.id && lineKeyFor(l.item.id, l.options) === key,
    );
    if (existing) {
      existing.quantity = Math.min(LINE_CAP, existing.quantity + requestedQuantity);
      existing.requestedQuantity = Math.min(LINE_CAP, existing.requestedQuantity + requestedQuantity);
      continue;
    }
    lines.push({ item: dish, options, quantity: requestedQuantity, requestedQuantity });
  }

  // Rung 5: stock clamp AFTER merging, so duplicates of one dish collectively
  // respect the counter too.
  const clamped: OrderAgainPlan['clamped'] = [];
  for (const l of lines) {
    if (l.item.stock !== null && l.item.stock < l.quantity) {
      clamped.push({ name: l.item.name, from: l.quantity, to: Math.max(0, l.item.stock) });
      l.quantity = Math.max(0, l.item.stock);
    }
  }
  // A clamp to zero (stock fell in between rungs) demotes the line to sold-out.
  const finalLines = lines.filter((l) => {
    if (l.quantity <= 0) {
      skipped.push({ name: l.item.name, reason: 'sold-out' });
      return false;
    }
    return true;
  });

  const addedUnits = finalLines.reduce((s, l) => s + l.quantity, 0);
  const plannedSubtotalCents = finalLines.reduce(
    (s, l) => s + unitPriceCents(l.item, l.options) * l.quantity,
    0,
  );
  return { lines: finalLines, skipped, clamped, addedUnits, plannedSubtotalCents };
}
