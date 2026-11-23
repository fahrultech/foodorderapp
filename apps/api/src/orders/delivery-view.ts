/**
 * Tracking-page delivery polish (Phase 12 product item, session 119).
 *
 * Once an order is `delivering`, the receipt read (`GET /orders/:id` via
 * `findOneForViewer`) attaches a small `delivery` view: the assigned driver's
 * FIRST name and an honest "usually ~N min left" countdown derived from
 * session 113's per-restaurant ETA. Read-side embed only — no migration, no
 * new columns, and every other read/echo stays byte-identical.
 *
 * Rules encoded here (mirrored in ARCHITECTURE.md):
 * - Attached ONLY for status `delivering`: completed/cancelled history must
 *   never fabricate a future, and confirmed/preparing is kitchen time, not
 *   delivery time.
 * - The countdown anchors on the ETA's OWN basis: the ETA measures
 *   confirmed->completed, so remaining = ETA seconds minus the confirmed->now
 *   elapsed. No `confirmedAt` (legacy/garbage row) -> `createdAt` is the
 *   honest fallback anchor; neither -> null (driver name only, no fake
 *   countdown).
 * - The ETA `source` rides along so the UI stays honest about the basis
 *   ('observed' median vs 'estimate' curated fallback, same semantics as
 *   session 113). A failed aggregate read surfaces as `eta: null` — the
 *   session-89 "extras degrade, the route stays 200" doctrine.
 * - Durations leave this module as INTEGER MINUTES, ceiled: a half-elapsed
 *   minute is not a finished one. Past-due never goes negative — 0 means
 *   "arriving soon", which is exactly what the storefront copy renders.
 * - DI-free and clock-free like the session-113 builder: `now` arrives as a
 *   parameter, so the pure logic is unit-testable without a DB or a clock.
 */
import {
  buildDeliveryEta,
  EtaSqlRow,
} from '../restaurants/delivery-eta';

/** The eta `source` values session 113 established. */
export type DeliveryViewEtaSource = 'observed' | 'estimate';

export interface OrderDeliveryView {
  /** First whitespace-separated token of the driver's name; null when the
   *  order has no driver assigned (or the users read failed). */
  driverFirstName: string | null;
  /** Derivation basis (session 113 semantics); null ONLY when the ETA
   *  aggregate read failed this request. */
  etaSource: DeliveryViewEtaSource | null;
  /** Eligible completed orders behind an 'observed' basis; 0 otherwise. */
  sampleCount: number;
  /** Whole minutes remaining (0 = arriving soon); null when no honest
   *  countdown exists (no usable anchor stamp, or the read failed). */
  remainingMinutes: number | null;
}

export interface OrderDeliveryInput {
  /**
   * The restaurant's aggregate row from DELIVERY_ETA_SQL. THREE states:
   * `undefined` = no eligible completed orders yet (estimate branch, 0
   * samples — same semantics as session 113); `null` = the aggregate read
   * FAILED this request (honest eta:null degrade).
   */
  etaRow: EtaSqlRow | null | undefined;
  /** Curated fallback input for buildDeliveryEta (restaurant relation). */
  avgPrepMinutes: number | null | undefined;
  /** The assigned driver user's full name, if resolvable. */
  driverName: string | null | undefined;
  confirmedAt: Date | string | null | undefined;
  createdAt: Date | string | null | undefined;
}

/** 'Demo Driver' -> 'Demo'; garbage/empty collapses to null (never ''). */
export function firstNameOf(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const first = name.trim().split(/\s+/)[0];
  return first || null;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Pure builder for the `delivery` view. NEVER throws; every missing/garbage
 * input degrades to the most honest null instead of a fabricated future.
 */
export function buildOrderDeliveryView(
  input: OrderDeliveryInput,
  now: Date = new Date(),
): OrderDeliveryView {
  const driverFirstName = firstNameOf(input.driverName);
  if (input.etaRow === null) {
    // Aggregate read failed: countdown impossible without a fabricating
    // basis — the driver line may still stand on its own.
    return { driverFirstName, etaSource: null, sampleCount: 0, remainingMinutes: null };
  }
  const eta = buildDeliveryEta(input.etaRow, input.avgPrepMinutes);
  const anchor = toDate(input.confirmedAt) ?? toDate(input.createdAt);
  let remainingMinutes: number | null = null;
  if (anchor) {
    const elapsedSec = (now.getTime() - anchor.getTime()) / 1000;
    remainingMinutes = Math.max(0, Math.ceil((eta.seconds - elapsedSec) / 60));
  }
  return {
    driverFirstName,
    etaSource: eta.source as DeliveryViewEtaSource,
    sampleCount: eta.sampleCount,
    remainingMinutes,
  };
}
