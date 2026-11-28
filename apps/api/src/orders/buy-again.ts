/**
 * "Buy again" server-side revalidation core (Phase 17, session 149).
 *
 * DI/React-free pure function: given an order's FROZEN item rows and the
 * CURRENT dish rows (+ attached option groups), decide exactly which cart
 * lines can honestly be rebuilt, which must be reported as skipped, and —
 * the rung the session-107 client ladder deliberately did NOT report —
 * how far each riding line's price has drifted since the order.
 *
 * Semantics mirror `apps/web/lib/order-again.ts` rung-for-rung so the
 * client fallback and the server authority never disagree on WHICH lines
 * ride:
 *  1. `menuItemId` null (FK SET NULL after a hard delete), no current row,
 *     or the dish now belongs to a DIFFERENT restaurant -> 'gone'
 *  2. dish exists but `isAvailable: false` -> 'unavailable'
 *  3. tracked stock at 0 -> 'sold-out'
 *  4. every frozen choiceId must still live in the SAME option group, and
 *     the rebuilt selection must satisfy the CURRENT per-group min/max
 *     (a group added/deleted/priced away since the order cannot be
 *     second-guessed) -> 'options-changed'
 *  5. duplicate dish+selection rows MERGE (the cart keys by line identity),
 *     and a tracked-stock shortfall CLAMPS the merged quantity.
 *
 * Prices are ALWAYS the current menu's (base + current choice deltas) — the
 * server re-prices from choice ids at order-create anyway, so a drift never
 * BLOCKS a re-order. It is, however, REPORTED: each riding line carries its
 * frozen unit price next to the current one (integer cents end to end).
 *
 * No repository, no Nest: the service narrows its reads to these shapes and
 * hands the rows over. Every rule lives HERE so unit specs can pin the whole
 * ladder without a DB.
 */
import { OrderOptionSnapshot } from '../menu/order-option-snapshot';

export type BuyAgainSkipReason = 'gone' | 'unavailable' | 'sold-out' | 'options-changed';

/** Narrow projection of the CURRENT menu row the ladder reads. */
export interface BuyAgainChoice {
  id: string;
  name: string;
  priceDeltaCents: number;
}

export interface BuyAgainGroup {
  id: string;
  name: string;
  minChoices: number;
  maxChoices: number;
  choices: BuyAgainChoice[];
}

export interface BuyAgainDish {
  id: string;
  name: string;
  priceCents: number;
  isAvailable: boolean;
  /** null = UNLIMITED (the seeded default); a number = tracked units. */
  stock: number | null;
  /** Rung 1 guard: a dish moved to another restaurant is 'gone' here. */
  restaurantId: string;
  optionGroups: BuyAgainGroup[];
}

/** Narrow projection of ONE frozen order_items row. */
export interface BuyAgainOrderedRow {
  name: string;
  quantity: number;
  /** Snapshot unit price INCL. option deltas — the drift baseline. */
  unitPriceCents: number;
  menuItemId: string | null;
  optionSelections: OrderOptionSnapshot[] | null;
}

/** Rebuilt option row (same wire shape as the web CartLineOption). */
export interface BuyAgainSelection {
  groupId: string;
  groupName: string;
  choiceId: string;
  choiceName: string;
  priceDeltaCents: number;
}

export interface BuyAgainLine {
  /** The CURRENT dish row (the cart stores this shape; prices are today's). */
  dish: BuyAgainDish;
  options: BuyAgainSelection[];
  /** Already stock-clamped; duplicates of one dish+selection merged. */
  quantity: number;
  /** The frozen quantity summed pre-clamp, capped the same way. */
  requestedQuantity: number;
  /** Sum of the frozen rows' unitPriceCents * qty (drift baseline). */
  snapshotUnitPriceCents: number;
  /** dish.priceCents + current selection deltas. */
  currentUnitPriceCents: number;
  /** current - snapshot; NEGATIVE is a price drop. Display-report only. */
  priceDeltaCents: number;
}

export interface BuyAgainPlanCore {
  lines: BuyAgainLine[];
  skipped: Array<{ name: string; reason: BuyAgainSkipReason }>;
  clamped: Array<{ name: string; from: number; to: number }>;
  addedUnits: number;
  /** Riding lines at CURRENT prices (integer cents). */
  plannedSubtotalCents: number;
  /** The same riding lines priced at the FROZEN snapshot (drift baseline). */
  snapshotSubtotalCents: number;
  /** plannedSubtotalCents - snapshotSubtotalCents. */
  priceDriftCents: number;
}

/** The cart caps one line at 50 units — the planner pre-applies the same
 *  ceiling so the clamp report matches what will ever be stored. */
const LINE_CAP = 50;

function clampQuantity(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  return Math.min(LINE_CAP, Math.max(1, Math.floor(raw)));
}

function currentUnitPriceCents(dish: BuyAgainDish, options: BuyAgainSelection[]): number {
  return dish.priceCents + options.reduce((s, o) => s + o.priceDeltaCents, 0);
}

/** Line identity: dish + sorted choice ids — same contract as the web's
 *  lineKeyFor, which is what the cart dedupes on. */
function lineKey(dishId: string, options: BuyAgainSelection[]): string {
  return `${dishId}|${options
    .map((o) => o.choiceId)
    .sort()
    .join(',')}`;
}

export function computeBuyAgainPlan(
  rows: BuyAgainOrderedRow[],
  dishes: BuyAgainDish[],
  restaurantId: string,
): BuyAgainPlanCore {
  const byId = new Map(dishes.map((d) => [d.id, d]));
  const skipped: BuyAgainPlanCore['skipped'] = [];
  const merged: BuyAgainLine[] = [];
  const keyIndex = new Map<string, BuyAgainLine>();

  for (const row of rows) {
    const name = row.name;
    // Rung 1: hard-deleted dish (FK nulled the id), missing current row, or
    // a dish the owner moved to another restaurant.
    if (!row.menuItemId) {
      skipped.push({ name, reason: 'gone' });
      continue;
    }
    const dish = byId.get(row.menuItemId);
    if (!dish || dish.restaurantId !== restaurantId) {
      skipped.push({ name, reason: 'gone' });
      continue;
    }
    // Rung 2: the owner hid it since.
    if (!dish.isAvailable) {
      skipped.push({ name, reason: 'unavailable' });
      continue;
    }
    // Rung 3: tracked counter at zero.
    if (dish.stock === 0) {
      skipped.push({ name, reason: 'sold-out' });
      continue;
    }
    // Rung 4: rebuild the option rows from the frozen receipt. Every choice
    // must still exist inside the SAME group; the rebuilt selection must
    // still satisfy each group's CURRENT min/max. Anything else is
    // guessing at intent — skip and report.
    const groups = dish.optionGroups;
    const snapshot = row.optionSelections ?? [];
    const options: BuyAgainSelection[] = [];
    let optionsBroken = false;
    const seen = new Set<string>();
    for (const s of snapshot) {
      if (seen.has(s.choiceId)) continue; // defensive: the receipt never repeats a choice
      seen.add(s.choiceId);
      const group = groups.find((g) => g.id === s.groupId);
      const choice = group?.choices.find((c) => c.id === s.choiceId);
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

    // Rung 5 (merge half): same dish + same selection rides as ONE line.
    // The snapshot price of a merged line is the FIRST row's unit price —
    // duplicate rows of one dish+selection share it by construction (same
    // base + same deltas at create time), so no averaging is needed.
    const requested = clampQuantity(row.quantity);
    const key = lineKey(dish.id, options);
    const existing = keyIndex.get(key);
    if (existing) {
      existing.quantity = Math.min(LINE_CAP, existing.quantity + requested);
      existing.requestedQuantity = Math.min(LINE_CAP, existing.requestedQuantity + requested);
      continue;
    }
    const unit = currentUnitPriceCents(dish, options);
    const line: BuyAgainLine = {
      dish,
      options,
      quantity: requested,
      requestedQuantity: requested,
      snapshotUnitPriceCents: Number.isFinite(row.unitPriceCents) ? row.unitPriceCents : unit,
      currentUnitPriceCents: unit,
      priceDeltaCents: unit - (Number.isFinite(row.unitPriceCents) ? row.unitPriceCents : unit),
    };
    merged.push(line);
    keyIndex.set(key, line);
  }

  // Rung 5 (clamp half): after merging, so duplicates of one dish
  // collectively respect the counter.
  const clamped: BuyAgainPlanCore['clamped'] = [];
  for (const l of merged) {
    if (l.dish.stock !== null && l.dish.stock < l.quantity) {
      clamped.push({ name: l.dish.name, from: l.quantity, to: Math.max(0, l.dish.stock) });
      l.quantity = Math.max(0, l.dish.stock);
    }
  }
  // A clamp to zero demotes the line to sold-out (never fold 0-qty lines).
  const lines = merged.filter((l) => {
    if (l.quantity <= 0) {
      skipped.push({ name: l.dish.name, reason: 'sold-out' });
      return false;
    }
    return true;
  });

  let addedUnits = 0;
  let plannedSubtotalCents = 0;
  let snapshotSubtotalCents = 0;
  for (const l of lines) {
    addedUnits += l.quantity;
    plannedSubtotalCents += l.currentUnitPriceCents * l.quantity;
    snapshotSubtotalCents += l.snapshotUnitPriceCents * l.quantity;
  }
  return {
    lines,
    skipped,
    clamped,
    addedUnits,
    plannedSubtotalCents,
    snapshotSubtotalCents,
    priceDriftCents: plannedSubtotalCents - snapshotSubtotalCents,
  };
}
