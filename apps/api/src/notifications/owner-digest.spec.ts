import {
  buildDigestView,
  digestWindow,
  rankTopDishes,
  resolveDigestConfig,
  runOwnerDigest,
  ymdLocal,
  type DigestLogRow,
  type DigestMailOutcome,
  type DishSaleRow,
  type OwnerDigestPorts,
  type OwnerDigestConfig,
  type OwnerRestaurantRow,
  type RestaurantStatRow,
} from './owner-digest';

/**
 * Owner-digest core unit spec (Phase 17 Product loop). The fake ports
 * capture EVERY ledger + mail interaction so each roadmap rule is an
 * executable pin: one mail per owner per day, zero mail for no orders,
 * opt-out silence, fail-then-release retry, stale-claim take-over, and
 * dry-run touching NOTHING. SQL truth for the real adapters lives in the
 * live smoke (script boots the runner against a scratch DB).
 */

const DAY = '2026-11-27';

function ownerRow(
  over: Partial<OwnerRestaurantRow> & { ownerId: string; restaurantId: string },
): OwnerRestaurantRow {
  return {
    ownerEmail: `${over.ownerId}@owner.test`,
    ownerName: `Owner ${over.ownerId}`,
    orderEmailEnabled: true,
    restaurantName: `Restaurant ${over.restaurantId}`,
    ...over,
  };
}

type ClaimMode = 'succeed' | 'conflict';

interface Harness {
  ports: OwnerDigestPorts;
  calls: {
    claims: Array<Omit<DigestLogRow, 'id' | 'sentAt'>>;
    refreshed: Array<{ id: string; claimedAt: Date }>;
    sent: Array<{ id: string; sentAt: Date }>;
    released: string[];
    mails: Array<{ to: string; subject: string; text: string }>;
  };
  setOutcome(o: DigestMailOutcome): void;
  setClaimMode(m: ClaimMode): void;
}

function harness(opts: {
  owners?: OwnerRestaurantRow[];
  stats?: RestaurantStatRow[];
  dishes?: DishSaleRow[];
  ledger?: DigestLogRow[];
  now?: Date;
}): Harness {
  const now = opts.now ?? new Date(`${DAY}T08:00:00`);
  const calls = { claims: [], refreshed: [], sent: [], released: [], mails: [] };
  let outcome: DigestMailOutcome = 'sent';
  let claimMode: ClaimMode = 'succeed';
  const ports: OwnerDigestPorts = {
    listOwnerRestaurants: async () => opts.owners ?? [],
    orderStats: async () => opts.stats ?? [],
    dishSales: async () => opts.dishes ?? [],
    findDigestRows: async () => opts.ledger ?? [],
    claimDigest: async (row) => {
      calls.claims.push(row);
      if (claimMode === 'conflict') return null; // UNIQUE violation stand-in
      return { id: `claim-${calls.claims.length}`, sentAt: null, ...row };
    },
    refreshClaim: async (id, _stats, claimedAt) => {
      calls.refreshed.push({ id, claimedAt });
    },
    markSent: async (id, sentAt) => {
      calls.sent.push({ id, sentAt });
    },
    releaseClaim: async (id) => {
      calls.released.push(id);
    },
    sendMail: async (to, subject, text) => {
      calls.mails.push({ to, subject, text });
      return outcome;
    },
    now: () => now,
  };
  return {
    calls,
    setOutcome: (o) => {
      outcome = o;
    },
    setClaimMode: (m) => {
      claimMode = m;
    },
    ports,
  };
}

function config(over: Partial<OwnerDigestConfig> = {}): OwnerDigestConfig {
  return { date: DAY, dryRun: false, claimStaleMinutes: 30, topDishes: 3, ...over };
}

const ONE_OWNER: OwnerRestaurantRow[] = [
  ownerRow({ ownerId: 'o1', restaurantId: 'r1', restaurantName: 'Warung A' }),
  ownerRow({ ownerId: 'o1', restaurantId: 'r2', restaurantName: 'Seoul B' }),
];

const STATS: RestaurantStatRow[] = [
  { restaurantId: 'r1', orderCount: 5, completedCount: 4, cancelledCount: 1, revenueCents: 125_000 },
  { restaurantId: 'r2', orderCount: 2, completedCount: 2, cancelledCount: 0, revenueCents: 30_000 },
];

const DISHES: DishSaleRow[] = [
  { restaurantId: 'r1', name: 'Nasi Goreng', quantity: 8 },
  { restaurantId: 'r1', name: 'Es Teh', quantity: 5 },
  { restaurantId: 'r1', name: 'Sate', quantity: 5 },
  { restaurantId: 'r1', name: 'Gado-Gado', quantity: 2 },
  { restaurantId: 'r2', name: 'Bibimbap', quantity: 3 },
];

describe('resolveDigestConfig', () => {
  it('defaults to YESTERDAY in local time', () => {
    const now = new Date(2026, 10, 28, 13, 30, 0); // 2026-11-28 local
    expect(resolveDigestConfig({}, now).date).toBe('2026-11-27');
    // Month-boundary: the 1st digests LAST MONTH'S last day.
    expect(resolveDigestConfig({}, new Date(2026, 10, 1)).date).toBe('2026-10-31');
  });

  it('accepts a valid DIGEST_DATE verbatim', () => {
    expect(resolveDigestConfig({ DIGEST_DATE: ' 2026-11-25 ' }).date).toBe('2026-11-25');
  });

  it('rejects malformed and impossible DIGEST_DATE values', () => {
    expect(() => resolveDigestConfig({ DIGEST_DATE: '2026-11-5' })).toThrow(/YYYY-MM-DD/);
    expect(() => resolveDigestConfig({ DIGEST_DATE: '2026-13-45' })).toThrow(/calendar day/);
    expect(() => resolveDigestConfig({ DIGEST_DATE: '2026-02-30' })).toThrow(/calendar day/);
  });

  it('parses the dry-run and stale-window knobs', () => {
    expect(resolveDigestConfig({ DIGEST_DRY_RUN: '1' }).dryRun).toBe(true);
    expect(resolveDigestConfig({ DIGEST_DRY_RUN: 'true' }).dryRun).toBe(true);
    expect(resolveDigestConfig({ DIGEST_DRY_RUN: 'yes' }).dryRun).toBe(false);
    expect(resolveDigestConfig({ DIGEST_CLAIM_STALE_MINUTES: '5' }).claimStaleMinutes).toBe(5);
    expect(() => resolveDigestConfig({ DIGEST_CLAIM_STALE_MINUTES: '0' })).toThrow(/positive/);
    expect(() => resolveDigestConfig({ DIGEST_CLAIM_STALE_MINUTES: 'abc' })).toThrow(/positive/);
  });
});

describe('digestWindow / ymdLocal', () => {
  it('is the CLOSED-OPEN local day [00:00, next 00:00)', () => {
    const { start, end } = digestWindow(DAY);
    expect(start).toEqual(new Date(2026, 10, 27, 0, 0, 0, 0));
    expect(end).toEqual(new Date(2026, 10, 28, 0, 0, 0, 0));
    expect(end.getTime() - start.getTime()).toBeGreaterThanOrEqual(86_400_000);
  });

  it('zero-pads month and day', () => {
    expect(ymdLocal(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('rankTopDishes', () => {
  it('sorts qty DESC, name ASC for ties, and slices to topN', () => {
    const rows: DishSaleRow[] = [
      { restaurantId: 'r', name: 'Beta', quantity: 5 },
      { restaurantId: 'r', name: 'Alpha', quantity: 5 },
      { restaurantId: 'r', name: 'Gamma', quantity: 9 },
      { restaurantId: 'r', name: 'Delta', quantity: 2 },
    ];
    expect(rankTopDishes(rows, 3)).toEqual([
      { name: 'Gamma', quantity: 9 },
      { name: 'Alpha', quantity: 5 },
      { name: 'Beta', quantity: 5 },
    ]);
  });
});

describe('buildDigestView', () => {
  it('returns null when NO restaurant has a single order', () => {
    expect(buildDigestView('Owner', DAY, ONE_OWNER, new Map(), new Map(), 3)).toBeNull();
  });

  it('sums owner totals across restaurants and keeps per-restaurant sections', () => {
    const stats = new Map(STATS.map((s) => [s.restaurantId, s]));
    const dishes = new Map<string, DishSaleRow[]>();
    for (const d of DISHES) {
      if (!dishes.has(d.restaurantId)) dishes.set(d.restaurantId, []);
      dishes.get(d.restaurantId)!.push(d);
    }
    const view = buildDigestView('Owner', DAY, ONE_OWNER, stats, dishes, 3);
    expect(view).not.toBeNull();
    expect(view!.orderCount).toBe(7);
    expect(view!.revenueCents).toBe(155_000);
    expect(view!.restaurants.map((r) => r.name)).toEqual(['Warung A', 'Seoul B']);
    expect(view!.restaurants[0].topDishes).toEqual([
      { name: 'Nasi Goreng', quantity: 8 },
      { name: 'Es Teh', quantity: 5 },
      { name: 'Sate', quantity: 5 },
    ]);
  });
});

describe('runOwnerDigest ledger + mail gates', () => {
  it('sends EXACTLY ONE mail per owner and rides the claim -> markSent path', async () => {
    const h = harness({ owners: ONE_OWNER, stats: STATS, dishes: DISHES });
    const first = await runOwnerDigest(h.ports, config());
    expect(first.totals).toMatchObject({ ownersWithRestaurants: 1, sent: 1, failed: 0, skipped: 0 });
    expect(h.calls.mails).toHaveLength(1);
    expect(h.calls.mails[0].to).toBe('o1@owner.test');
    expect(h.calls.mails[0].subject).toBe(`FoodOrder owner digest - ${DAY}`);
    expect(h.calls.mails[0].text).toContain('Warung A');
    expect(h.calls.mails[0].text).toContain('Seoul B');
    expect(h.calls.claims).toHaveLength(1);
    expect(h.calls.claims[0]).toMatchObject({
      ownerId: 'o1', digestDate: DAY, restaurantCount: 2, orderCount: 7, revenueCents: 155_000,
    });
    expect(h.calls.sent).toEqual([{ id: 'claim-1', sentAt: expect.any(Date) }]);
  });

  it('SAME-DAY re-run with a delivered ledger row: silent', async () => {
    const h = harness({
      owners: ONE_OWNER, stats: STATS, dishes: DISHES,
      ledger: [ledgerRow('c1', { sentAt: new Date(`${DAY}T07:59:00`) })],
    });
    const report = await runOwnerDigest(h.ports, config());
    expect(report.owners[0].status).toBe('skipped-already-sent');
    expect(h.calls.mails).toHaveLength(0);
    expect(h.calls.claims).toHaveLength(0);
  });

  it('zero-orders owner gets NO mail and NO ledger row', async () => {
    const h = harness({ owners: ONE_OWNER, stats: [], dishes: [] });
    const report = await runOwnerDigest(h.ports, config());
    expect(report.owners[0].status).toBe('skipped-no-orders');
    expect(h.calls.mails).toHaveLength(0);
    expect(h.calls.claims).toHaveLength(0);
  });

  it('opt-out owner is silent even with full stats', async () => {
    const opted = [
      ownerRow({ ownerId: 'o1', restaurantId: 'r1', restaurantName: 'Warung A', orderEmailEnabled: false }),
      ownerRow({ ownerId: 'o1', restaurantId: 'r2', restaurantName: 'Seoul B', orderEmailEnabled: false }),
    ];
    const h = harness({ owners: opted, stats: STATS, dishes: DISHES });
    const report = await runOwnerDigest(h.ports, config());
    expect(report.owners[0].status).toBe('skipped-opt-out');
    expect(h.calls.mails).toHaveLength(0);
    expect(h.calls.claims).toHaveLength(0);
  });

  it('a fresh in-flight claim is NOT taken over', async () => {
    const h = harness({
      owners: ONE_OWNER, stats: STATS, dishes: DISHES,
      ledger: [ledgerRow('c1', { claimedAt: new Date(`${DAY}T07:55:00`) })], // now - 5min
    });
    const report = await runOwnerDigest(h.ports, config());
    expect(report.owners[0].status).toBe('skipped-claim-in-flight');
    expect(h.calls.mails).toHaveLength(0);
    expect(h.calls.refreshed).toHaveLength(0);
  });

  it('a STALE claim is taken over: refreshed, sent, and counted as a send', async () => {
    const h = harness({
      owners: ONE_OWNER, stats: STATS, dishes: DISHES,
      ledger: [ledgerRow('c1', { claimedAt: new Date(`${DAY}T07:29:00`) })], // now - 31min
    });
    const report = await runOwnerDigest(h.ports, config());
    expect(report.owners[0].status).toBe('took-over-stale-claim');
    expect(report.totals.sent).toBe(1); // take-over deliveries count as sent
    expect(h.calls.refreshed).toHaveLength(1);
    expect(h.calls.mails).toHaveLength(1);
    expect(h.calls.sent).toEqual([{ id: 'c1', sentAt: expect.any(Date) }]);
    expect(h.calls.claims).toHaveLength(0); // no second insert on take-over
  });

  it('a failed send RELEASES the claim so the next tick retries', async () => {
    const h = harness({ owners: ONE_OWNER, stats: STATS, dishes: DISHES });
    h.setOutcome('failed');
    const report = await runOwnerDigest(h.ports, config());
    expect(report.owners[0].status).toBe('failed');
    expect(report.totals.failed).toBe(1);
    expect(h.calls.released).toEqual(['claim-1']);
    expect(h.calls.sent).toHaveLength(0);
  });

  it('a disabled mail channel releases the claim and skips (never "failed")', async () => {
    const h = harness({ owners: ONE_OWNER, stats: STATS, dishes: DISHES });
    h.setOutcome('disabled');
    const report = await runOwnerDigest(h.ports, config());
    expect(report.owners[0].status).toBe('skipped-mail-disabled');
    expect(report.totals.failed).toBe(0);
    expect(h.calls.released).toEqual(['claim-1']);
  });

  it('a claim conflict (row appeared under us) sends nothing', async () => {
    const h = harness({ owners: ONE_OWNER, stats: STATS, dishes: DISHES });
    h.setClaimMode('conflict');
    const report = await runOwnerDigest(h.ports, config());
    expect(report.owners[0].status).toBe('skipped-claim-conflict');
    expect(h.calls.mails).toHaveLength(0);
    expect(h.calls.released).toHaveLength(0);
    expect(h.calls.sent).toHaveLength(0);
  });

  it('dry-run reports intent but touches NEITHER ledger NOR mail', async () => {
    const h = harness({ owners: ONE_OWNER, stats: STATS, dishes: DISHES });
    const report = await runOwnerDigest(h.ports, config({ dryRun: true }));
    expect(report.owners[0]).toMatchObject({ status: 'dry-run', orderCount: 7, revenueCents: 155_000 });
    expect(report.dryRun).toBe(true);
    expect(h.calls.mails).toHaveLength(0);
    expect(h.calls.claims).toHaveLength(0);
    expect(h.calls.refreshed).toHaveLength(0);
    expect(h.calls.released).toHaveLength(0);
    expect(h.calls.sent).toHaveLength(0);
  });

  it('two owners -> exactly two mails, each covering only its OWN restaurants', async () => {
    const owners = [
      ...ONE_OWNER,
      ownerRow({ ownerId: 'o2', restaurantId: 'r3', restaurantName: 'Cafe C' }),
    ];
    const stats = [
      ...STATS,
      { restaurantId: 'r3', orderCount: 1, completedCount: 1, cancelledCount: 0, revenueCents: 5_000 },
    ];
    const h = harness({ owners, stats, dishes: DISHES });
    const report = await runOwnerDigest(h.ports, config());
    expect(report.owners.map((o) => o.status)).toEqual(['sent', 'sent']);
    expect(report.totals.sent).toBe(2);
    expect(h.calls.mails).toHaveLength(2);
    expect(h.calls.mails.map((m) => m.to).sort()).toEqual(['o1@owner.test', 'o2@owner.test']);
    const o1Mail = h.calls.mails.find((m) => m.to === 'o1@owner.test')!;
    const o2Mail = h.calls.mails.find((m) => m.to === 'o2@owner.test')!;
    expect(o1Mail.text).toContain('Warung A');
    expect(o1Mail.text).not.toContain('Cafe C');
    expect(o2Mail.text).toContain('Cafe C');
    expect(o2Mail.text).not.toContain('Seoul B');
  });

  it('owner with orders only on a NON-owned restaurant is skipped (window scoping)', async () => {
    // The SQL scoping is live-smoke truth; here the core simply never sees
    // stats for ids outside the owner's list -> zero orders -> skip.
    const owners = [ownerRow({ ownerId: 'o9', restaurantId: 'r9' })];
    const h = harness({ owners, stats: STATS, dishes: DISHES });
    const report = await runOwnerDigest(h.ports, config());
    expect(report.owners[0].status).toBe('skipped-no-orders');
  });
});

function ledgerRow(id: string, over: Partial<DigestLogRow> = {}): DigestLogRow {
  return {
    id,
    ownerId: 'o1',
    digestDate: DAY,
    restaurantCount: 2,
    orderCount: 7,
    revenueCents: 155_000,
    claimedAt: new Date(`${DAY}T07:00:00`),
    sentAt: null,
    ...over,
  };
}
