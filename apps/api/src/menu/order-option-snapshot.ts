/**
 * Immutable receipt of ONE selected option choice on an order line
 * (Phase 5 menu options/variants). Stored as a JSONB array on
 * `order_items.option_selections` — same snapshot philosophy as the
 * name/unitPriceCents columns: later menu edits or deletions never
 * rewrite past orders.
 */
export interface OrderOptionSnapshot {
  /** Option group the choice belonged to at order time ("Size", "Add-ons"). */
  groupId: string;
  /** Group label snapshot (menus may be renamed/deleted afterwards). */
  groupName: string;
  /** Choice id — informational; no FK, kept even if the choice is deleted. */
  choiceId: string;
  /** Choice label snapshot. */
  choiceName: string;
  /** Price delta in integer cents that was folded into the unit price. */
  priceDeltaCents: number;
}

/** Per-line resolution result of MenuOptionService.resolveSelections. */
export interface ResolvedOptionLine {
  /** Sum of the selected choices' price deltas (integer cents, >= 0). */
  extraCents: number;
  /** Ordered receipt rows to store on the order line (empty = no options). */
  selections: OrderOptionSnapshot[];
}
