import {
  ownerDigestEmail,
  type DigestEmailView,
  type DigestRestaurantView,
} from './email-copy';

/**
 * Owner daily digest core (docs/ROADMAP.md Phase 17, Product loop).
 *
 * DI-light pure module, same doctrine as stale-order-sweep.ts: the RULES
 * (window arithmetic, zero-mail-for-no-orders, opt-out, exactly-once claim
 * ledger, stale-claim take-over, fail-then-release retry) live HERE against
 * narrow ports so the unit spec exercises every branch with fakes, while
 * the standalone cron runner (src/scripts/owner-digest.ts) supplies the
 * TypeORM + MailService adapters. The app process never imports this module.
 *
 * Money stays integer cents end to end; only email-copy's formatCents
 * renders it.
 */

/** What a send attempt settled as (mirrors MailService.send's result). */
export type DigestMailOutcome = 'sent' | 'failed' | 'disabled';

/** Ledger row shape (structural subset of OwnerDigestLog). */
export interface DigestLogRow {
  id: string;
  ownerId: string;
  digestDate: string;
  restaurantCount: number;
  orderCount: number;
  revenueCents: number;
  claimedAt: Date;
  sentAt: Date | null;
}

/** One owner-scoped restaurant (flattened join row). */
export interface OwnerRestaurantRow {
  ownerId: string;
  ownerEmail: string;
  ownerName: string;
  orderEmailEnabled: boolean;
  restaurantId: string;
  restaurantName: string;
}

export interface RestaurantStatRow {
  restaurantId: string;
  orderCount: number;
  completedCount: number;
  cancelledCount: number;
  revenueCents: number;
}

export interface DishSaleRow {
  restaurantId: string;
  name: string;
  quantity: number;
}

export interface OwnerDigestPorts {
  listOwnerRestaurants(): Promise<OwnerRestaurantRow[]>;
  orderStats(start: Date, end: Date, restaurantIds: string[]): Promise<RestaurantStatRow[]>;
  dishSales(start: Date, end: Date, restaurantIds: string[]): Promise<DishSaleRow[]>;
  findDigestRows(digestDate: string): Promise<DigestLogRow[]>;
  /** INSERT the claim; returns null when the UNIQUE pair already exists. */
  claimDigest(row: Omit<DigestLogRow, 'id' | 'sentAt'>): Promise<DigestLogRow | null>;
  /** Take over a stale claim: refresh stats + claimedAt, sentAt back to NULL. */
  refreshClaim(
    id: string,
    stats: { restaurantCount: number; orderCount: number; revenueCents: number },
    claimedAt: Date,
  ): Promise<void>;
  markSent(id: string, sentAt: Date): Promise<void>;
  releaseClaim(id: string): Promise<void>;
  sendMail(to: string, subject: string, text: string): Promise<DigestMailOutcome>;
  now(): Date;
}

export interface OwnerDigestConfig {
  /** Covered day, 'YYYY-MM-DD' (DIGEST_DATE; default: yesterday, local). */
  date: string;
  dryRun: boolean;
  /** DIGEST_CLAIM_STALE_MINUTES (default 30). */
  claimStaleMinutes: number;
  /** Top N dishes rendered per restaurant. */
  topDishes: number;
}

export const DIGEST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** [start, end) local-time boundaries of the covered day. */
export function digestWindow(date: string): { start: Date; end: Date } {
  const [y, m, d] = date.split('-').map(Number);
  return {
    start: new Date(y, m - 1, d, 0, 0, 0, 0),
    // Day-constructors (not +86_400_000 ms) so a DST host still closes at
    // the NEXT calendar midnight.
    end: new Date(y, m - 1, d + 1, 0, 0, 0, 0),
  };
}

export function resolveDigestConfig(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): OwnerDigestConfig {
  const rawDate = env.DIGEST_DATE?.trim();
  let date: string;
  if (rawDate) {
    if (!DIGEST_DATE_RE.test(rawDate)) {
      throw new Error(`DIGEST_DATE must be YYYY-MM-DD, got "${rawDate}"`);
    }
    // Round-trip rejects impossible calendar days (2026-13-45 etc.).
    const [y, m, d] = rawDate.split('-').map(Number);
    const probe = new Date(y, m - 1, d);
    if (ymdLocal(probe) !== rawDate) {
      throw new Error(`DIGEST_DATE is not a real calendar day: "${rawDate}"`);
    }
    date = rawDate;
  } else {
    const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
    date = ymdLocal(new Date(y, m, d - 1));
  }
  const stale = Number(env.DIGEST_CLAIM_STALE_MINUTES ?? '30');
  if (!Number.isFinite(stale) || stale <= 0) {
    throw new Error(`DIGEST_CLAIM_STALE_MINUTES must be a positive number, got "${env.DIGEST_CLAIM_STALE_MINUTES}"`);
  }
  return {
    date,
    dryRun: env.DIGEST_DRY_RUN === '1' || env.DIGEST_DRY_RUN === 'true',
    claimStaleMinutes: stale,
    topDishes: 3,
  };
}

/** Per-owner verdict; every branch the ledger + mail port can produce. */
export type OwnerDigestStatus =
  | 'sent'
  | 'dry-run'
  | 'failed'
  | 'skipped-mail-disabled'
  | 'skipped-no-orders'
  | 'skipped-opt-out'
  | 'skipped-already-sent'
  | 'skipped-claim-in-flight'
  | 'skipped-claim-conflict'
  | 'took-over-stale-claim';

export interface OwnerDigestResult {
  ownerId: string;
  email: string;
  date: string;
  status: OwnerDigestStatus;
  restaurantCount: number;
  orderCount: number;
  revenueCents: number;
}

export interface OwnerDigestReport {
  date: string;
  windowStart: string;
  windowEnd: string;
  dryRun: boolean;
  owners: OwnerDigestResult[];
  totals: {
    ownersWithRestaurants: number;
    sent: number;
    failed: number;
    claimed: number;
    skipped: number;
  };
}

/** qty DESC then name ASC (deterministic tie), sliced to topN. */
export function rankTopDishes(rows: DishSaleRow[], topN: number): Array<{ name: string; quantity: number }> {
  return [...rows]
    .sort((a, b) => b.quantity - a.quantity || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, topN)
    .map((r) => ({ name: r.name, quantity: r.quantity }));
}

/** Owner -> sorted restaurant sections; owners with NO orders anywhere drop. */
export function buildDigestView(
  ownerName: string,
  date: string,
  restaurants: OwnerRestaurantRow[],
  statsById: Map<string, RestaurantStatRow>,
  dishesById: Map<string, DishSaleRow[]>,
  topDishes: number,
): (DigestEmailView & { orderCount: number; revenueCents: number }) | null {
  const sections: DigestRestaurantView[] = [];
  let orderCount = 0;
  let revenueCents = 0;
  for (const r of restaurants) {
    const s = statsById.get(r.restaurantId);
    const counts = {
      orderCount: s?.orderCount ?? 0,
      completedCount: s?.completedCount ?? 0,
      cancelledCount: s?.cancelledCount ?? 0,
    };
    orderCount += counts.orderCount;
    revenueCents += s?.revenueCents ?? 0;
    sections.push({
      name: r.restaurantName,
      ...counts,
      revenueCents: s?.revenueCents ?? 0,
      topDishes: rankTopDishes(dishesById.get(r.restaurantId) ?? [], topDishes),
    });
  }
  if (orderCount === 0) return null; // zero-mail-for-no-orders rule
  // Restaurant sections follow the port's ORDER BY (u.id, r.name) — stable
  // without re-sorting here.
  return { ownerName, date, restaurants: sections, orderCount, revenueCents };
}

export async function runOwnerDigest(
  ports: OwnerDigestPorts,
  config: OwnerDigestConfig,
): Promise<OwnerDigestReport> {
  const { start, end } = digestWindow(config.date);
  const joined = await ports.listOwnerRestaurants();

  // Group the flattened join by owner, preserving join order (owner-sorted).
  const byOwner = new Map<string, OwnerRestaurantRow[]>();
  for (const row of joined) {
    const list = byOwner.get(row.ownerId);
    if (list) list.push(row);
    else byOwner.set(row.ownerId, [row]);
  }
  const ownedIds = [...new Set(joined.map((r) => r.restaurantId))];

  const [statsRows, dishRows, ledgerRows] = await Promise.all([
    ownedIds.length
      ? ports.orderStats(start, end, ownedIds)
      : Promise.resolve<RestaurantStatRow[]>([]),
    ownedIds.length
      ? ports.dishSales(start, end, ownedIds)
      : Promise.resolve<DishSaleRow[]>([]),
    ports.findDigestRows(config.date),
  ]);
  const statsById = new Map(statsRows.map((s) => [s.restaurantId, s]));
  const dishesById = new Map<string, DishSaleRow[]>();
  for (const d of dishRows) {
    const list = dishesById.get(d.restaurantId);
    if (list) list.push(d);
    else dishesById.set(d.restaurantId, [d]);
  }
  const ledgerByOwner = new Map(ledgerRows.map((l) => [l.ownerId, l]));

  const owners: OwnerDigestResult[] = [];
  for (const [ownerId, restaurants] of byOwner) {
    const head = restaurants[0];
    const base = {
      ownerId,
      email: head.ownerEmail,
      date: config.date,
      restaurantCount: restaurants.length,
    };

    // Opt-out FIRST: an owner who silenced platform email gets no claim, no
    // send, no ledger row — regardless of yesterday's volume.
    if (!head.orderEmailEnabled) {
      owners.push({ ...base, status: 'skipped-opt-out', orderCount: 0, revenueCents: 0 });
      continue;
    }

    const view = buildDigestView(
      head.ownerName,
      config.date,
      restaurants,
      statsById,
      dishesById,
      config.topDishes,
    );
    if (!view) {
      owners.push({
        ...base,
        status: 'skipped-no-orders',
        orderCount: 0,
        revenueCents: 0,
      });
      continue;
    }
    const { orderCount, revenueCents, ...emailView } = view;
    const aggregates = {
      restaurantCount: restaurants.length,
      orderCount,
      revenueCents,
    };

    if (config.dryRun) {
      owners.push({ ...base, status: 'dry-run', orderCount, revenueCents });
      continue;
    }

    // Exactly-once ledger gate.
    const existing = ledgerByOwner.get(ownerId);
    let claimId: string;
    let status: OwnerDigestStatus = 'sent';
    if (existing?.sentAt) {
      owners.push({ ...base, status: 'skipped-already-sent', orderCount, revenueCents });
      continue;
    }
    if (existing) {
      const ageMs = ports.now().getTime() - new Date(existing.claimedAt).getTime();
      if (ageMs < config.claimStaleMinutes * 60_000) {
        owners.push({ ...base, status: 'skipped-claim-in-flight', orderCount, revenueCents });
        continue;
      }
      // Stale (crashed) claim: refresh stats + clock, then send.
      await ports.refreshClaim(existing.id, aggregates, ports.now());
      claimId = existing.id;
      status = 'took-over-stale-claim';
    } else {
      const claimed = await ports.claimDigest({
        ownerId,
        digestDate: config.date,
        ...aggregates,
        claimedAt: ports.now(),
      });
      if (!claimed) {
        owners.push({ ...base, status: 'skipped-claim-conflict', orderCount, revenueCents });
        continue;
      }
      claimId = claimed.id;
    }

    const rendered = ownerDigestEmail(emailView);
    const outcome = await ports.sendMail(head.ownerEmail, rendered.subject, rendered.text);
    if (outcome === 'sent') {
      await ports.markSent(claimId, ports.now());
      owners.push({ ...base, status, orderCount, revenueCents });
    } else if (outcome === 'failed') {
      // Release so the NEXT tick retries — a dead relay must not cost the
      // owner the day's digest permanently.
      await ports.releaseClaim(claimId);
      owners.push({ ...base, status: 'failed', orderCount, revenueCents });
    } else {
      await ports.releaseClaim(claimId);
      owners.push({ ...base, status: 'skipped-mail-disabled', orderCount, revenueCents });
    }
  }

  return {
    date: config.date,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    dryRun: config.dryRun,
    owners,
    totals: {
      ownersWithRestaurants: byOwner.size,
      // A stale-claim take-over that delivered IS a send — the status just
      // records which claim path it took.
      sent: owners.filter(
        (o) => o.status === 'sent' || o.status === 'took-over-stale-claim',
      ).length,
      failed: owners.filter((o) => o.status === 'failed').length,
      claimed: owners.filter((o) => o.status === 'took-over-stale-claim').length,
      skipped: owners.filter((o) => o.status.startsWith('skipped-')).length,
    },
  };
}
