import { Repository } from 'typeorm';
import {
  resolveRestockRepairConfig,
  findRestockOrphans,
  runRestockRepair,
  RestockRepairOptions,
  DEFAULT_RESTOCK_REPAIR_BATCH,
  DEFAULT_RESTOCK_REPAIR_GRACE_MINUTES,
} from './stock-restock-repair';
import { StockDecrementEntry } from './stock-restock';
import { OrdersService } from './orders.service';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { PromosService } from '../promos/promos.service';
import { AddressesService } from '../users/addresses.service';
import { OrderEventsService } from './order-events.service';

/**
 * Restock REPAIR pass (docs/ROADMAP.md Phase 5, session-72 follow-up):
 * cancelled orders frozen mid-crash-window — `status='cancelled'`, a
 * non-empty `stockDecrements` snapshot, `stockRestockedAt` NULL — must get
 * their units back through the SAME exactly-once CAS primitive. These specs
 * pin the orphan predicate, the report arithmetic, the dryRun promise, and
 * the OrdersService wrapper. Real-DB crash/repair behavior is the live
 * smoke's job (DEVLOG session 73); here we pin orchestration + SQL shape.
 *
 * Session-71 trap applied to mocks: DML-with-RETURNING comes back as a
 * `[rows, rowCount]` TUPLE — every canned result uses the tuple shape.
 */

const O1 = '11111111-1111-4111-8111-111111111111';
const O2 = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-09T12:00:00Z');

const snap = (...entries: Array<[string, number]>): StockDecrementEntry[] =>
  entries.map(([menuItemId, quantity]) => ({ menuItemId, quantity }));

/**
 * Manager double with one query mock routing three SQL families:
 * orphan SELECT -> canned rows; marker CAS UPDATE -> canned winner sequence
 * (index by call order, `[]` = CAS lost); per-dish menu UPDATE -> recorded.
 */
function fakeManager(opts: {
  orphans?: Array<Record<string, unknown>>;
  casWinners?: number; // how many CAS calls win (default: all)
  throwOn?: 'select';
} = {}) {
  const orphans = opts.orphans ?? [];
  let casCalls = 0;
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const s = String(sql);
    if (s.includes('ORDER BY')) {
      if (opts.throwOn === 'select') throw new Error('select boom');
      return [orphans, orphans.length];
    }
    if (s.includes(`UPDATE "orders" SET "stockRestockedAt"`)) {
      const win = casCalls++ < (opts.casWinners ?? orphans.length);
      const rows = win ? [{ id: 'x' }] : [];
      return [rows, rows.length];
    }
    if (s.includes('"menu_items"')) {
      const rows = [{ stock: 1 }];
      return [rows, rows.length];
    }
    throw new Error(`unexpected SQL: ${s.slice(0, 80)}`);
  });
  const transaction = jest.fn(async (cb: any) => cb({ query }));
  // Deliberate `any` shape: the mock's union of tuple returns is structurally
  // narrower than EntityManager's generic query/transaction signatures, but
  // the module only ever calls these two methods (see rowsOfQueryResult).
  const manager = { query, transaction } as any;
  return { manager, query, transaction };
}

const orphanRow = (id: string, code: string, entries: StockDecrementEntry[]) => ({
  id,
  code,
  stockDecrements: entries,
});

describe('resolveRestockRepairConfig — env knobs', () => {
  it('falls back to defaults when env is unset, blank or garbage', () => {
    for (const env of [{}, { RESTOCK_REPAIR_GRACE_MINUTES: ' ', RESTOCK_REPAIR_BATCH: '' }] as any) {
      const cfg = resolveRestockRepairConfig(env as NodeJS.ProcessEnv);
      expect(cfg).toEqual({
        graceMinutes: DEFAULT_RESTOCK_REPAIR_GRACE_MINUTES,
        limit: DEFAULT_RESTOCK_REPAIR_BATCH,
      });
    }
    const cfg = resolveRestockRepairConfig({
      RESTOCK_REPAIR_GRACE_MINUTES: 'abc',
      RESTOCK_REPAIR_BATCH: '-3',
    });
    expect(cfg.graceMinutes).toBe(DEFAULT_RESTOCK_REPAIR_GRACE_MINUTES);
    expect(cfg.limit).toBe(DEFAULT_RESTOCK_REPAIR_BATCH);
  });

  it('honours valid positive integers', () => {
    expect(resolveRestockRepairConfig({ RESTOCK_REPAIR_GRACE_MINUTES: '2', RESTOCK_REPAIR_BATCH: '10' })).toEqual({
      graceMinutes: 2,
      limit: 10,
    });
  });
});

describe('findRestockOrphans — the orphan predicate', () => {
  it('pins the SQL shape: cancelled + marker NULL + non-empty array snapshot + grace cutoff + oldest-first bound', async () => {
    const { manager, query } = fakeManager({ orphans: [orphanRow(O1, 'FO-A', snap(['m1', 1]))] });
    const cutoff = new Date('2026-11-09T10:00:00Z');
    const rows = await findRestockOrphans(manager, cutoff, 7);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`WHERE "status" = 'cancelled'`);
    expect(sql).toContain('"stockRestockedAt" IS NULL');
    expect(sql).toContain(`jsonb_typeof("stockDecrements") = 'array'`);
    expect(sql).toContain(`jsonb_array_length("stockDecrements") > 0`);
    expect(sql).toContain('"updatedAt" < $1');
    expect(sql).toContain('ORDER BY "updatedAt" ASC');
    expect(sql).toContain('LIMIT $2');
    expect(params).toEqual([cutoff, 7]);
    expect(rows).toEqual([{ id: O1, code: 'FO-A', stockDecrements: snap(['m1', 1]) }]);
  });

  it('survives the [rows,rowCount] TUPLE shape from this TypeORM/pg stack', async () => {
    // The mock already returns tuples; this pins that a zero-row result maps
    // to an empty list (NOT a length-2 tuple masquerading as two rows).
    const { manager } = fakeManager({ orphans: [] });
    const rows = await findRestockOrphans(manager, new Date(), 10);
    expect(rows).toEqual([]);
  });
});

describe('runRestockRepair — the repair orchestration', () => {
  const opts = (o: Partial<RestockRepairOptions> = {}): RestockRepairOptions => ({
    now: NOW,
    graceMinutes: 10,
    limit: 500,
    ...o,
  });

  it('missing manager -> honest empty report, never throws', async () => {
    const report = await runRestockRepair(null, opts());
    expect(report).toEqual({
      graceMinutes: 10,
      cutoff: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      scanned: 0,
      repaired: 0,
      skipped: 0,
      capped: false,
      orders: [],
    });
  });

  it('repairs every orphan through the CAS and sums snapshot units per order', async () => {
    const { manager, query, transaction } = fakeManager({
      orphans: [
        orphanRow(O1, 'FO-A', snap(['zz', 2], ['aa', 1])),
        orphanRow(O2, 'FO-B', snap(['m9', 3])),
      ],
    });
    const report = await runRestockRepair(manager, opts());
    expect(report.scanned).toBe(2);
    expect(report.repaired).toBe(2);
    expect(report.skipped).toBe(0);
    expect(report.capped).toBe(false);
    expect(report.orders).toEqual([
      { id: O1, code: 'FO-A', units: 3 },
      { id: O2, code: 'FO-B', units: 3 },
    ]);
    // ONE restock transaction per orphan; dishes added back in SORTED order
    // (identical lock sequence as the create-side decrement).
    expect(transaction).toHaveBeenCalledTimes(2);
    const adds = query.mock.calls.filter((c: any) => String(c[0]).includes('"menu_items"'));
    expect(adds).toEqual([
      [expect.any(String), ['aa', 1]],
      [expect.any(String), ['zz', 2]],
      [expect.any(String), ['m9', 3]],
    ]);
  });

  it('a CAS loser (concurrent cancel won) is counted skipped and adds NOTHING', async () => {
    const { manager, query, transaction } = fakeManager({
      orphans: [orphanRow(O1, 'FO-A', snap(['m1', 2])), orphanRow(O2, 'FO-B', snap(['m2', 1]))],
      casWinners: 1,
    });
    const report = await runRestockRepair(manager, opts());
    expect(report.repaired).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.orders).toEqual([{ id: O1, code: 'FO-A', units: 2 }]);
    expect(transaction).toHaveBeenCalledTimes(2); // both attempted; one lost
    const adds = query.mock.calls.filter((c: any) => String(c[0]).includes('"menu_items"'));
    expect(adds).toEqual([[expect.any(String), ['m1', 2]]]); // only the winner's
  });

  it('a snapshot with no usable entry is a skipped no-op — no transaction opened', async () => {
    const junk = orphanRow(O1, 'FO-A', [
      { menuItemId: 'm1', quantity: 0 },
      { menuItemId: '', quantity: 5 },
    ] as unknown as StockDecrementEntry[]);
    const { manager, transaction } = fakeManager({ orphans: [junk] });
    const report = await runRestockRepair(manager, opts());
    expect(report.scanned).toBe(1);
    expect(report.repaired).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.orders).toEqual([]);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('capped=true when the run fills its whole batch', async () => {
    const { manager } = fakeManager({
      orphans: [orphanRow(O1, 'FO-A', snap(['m1', 1])), orphanRow(O2, 'FO-B', snap(['m2', 1]))],
    });
    const report = await runRestockRepair(manager, opts({ limit: 2 }));
    expect(report.capped).toBe(true);
    const r2 = await runRestockRepair(manager, opts({ limit: 500 }));
    expect(r2.capped).toBe(false);
  });

  it('dryRun lists exactly what a real run would return — and touches NOTHING', async () => {
    const { manager, query, transaction } = fakeManager({
      orphans: [orphanRow(O1, 'FO-A', snap(['m1', 2], ['m1', 3]))],
    });
    const report = await runRestockRepair(manager, opts({ dryRun: true }));
    expect(report.scanned).toBe(1);
    expect(report.repaired).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.orders).toEqual([{ id: O1, code: 'FO-A', units: 5 }]);
    expect(transaction).not.toHaveBeenCalled();
    expect(query.mock.calls.filter((c: any) => String(c[0]).includes('UPDATE'))).toEqual([]);
  });

  it('grace window is applied: cutoff = now - graceMinutes, forwarded to the scan', async () => {
    const { manager, query } = fakeManager({});
    const report = await runRestockRepair(manager, opts({ graceMinutes: 42 }));
    expect(report.cutoff).toBe(new Date(NOW.getTime() - 42 * 60_000).toISOString());
    const params = query.mock.calls[0][1] as unknown[];
    expect(params[0]).toEqual(new Date(report.cutoff));
    expect(report.graceMinutes).toBe(42);
  });

  it('a scan failure propagates (never a swallowed repair)', async () => {
    const { manager } = fakeManager({ throwOn: 'select' });
    await expect(runRestockRepair(manager, opts())).rejects.toThrow('select boom');
  });
});

// ---------------------------------------------------------------------------
// Service wiring — the HTTP admin path runs the SAME shared repair.
// ---------------------------------------------------------------------------

describe('OrdersService.restockRepair — wiring', () => {
  it('delegates to runRestockRepair over the repository manager and passes overrides through', async () => {
    const { manager, transaction } = fakeManager({
      orphans: [orphanRow(O1, 'FO-A', snap(['m1', 4]))],
    });
    const repo = { manager } as unknown as Repository<any>;
    const events = { publish: jest.fn() } as unknown as OrderEventsService;
    const service = new OrdersService(
      repo,
      {} as MenuService,
      {} as RestaurantsService,
      events,
      {} as PromosService,
      {} as AddressesService,
    );
    const report = await service.restockRepair({ now: NOW, graceMinutes: 10, limit: 500 });
    expect(report.repaired).toBe(1);
    expect(report.orders).toEqual([{ id: O1, code: 'FO-A', units: 4 }]);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
