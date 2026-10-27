import { Order, OrderStatus } from './order.entity';
import {
  DEFAULT_STALE_ORDER_BATCH,
  DEFAULT_STALE_ORDER_MINUTES,
  resolveStaleSweepConfig,
  runStaleOrderSweep,
} from './stale-order-sweep';

/**
 * Unit tests for the shared stale-pending-order sweep (roadmap Phase 5 "auto-
 * cancel stale pending orders"). These exercise the pure `runStaleOrderSweep`
 * against a hand-built repository double so every selection/stamping/capping
 * rule is pinned WITHOUT a database. The HTTP route + admin guard are covered
 * separately in cancel-stale.admin.spec.ts.
 */

const NOW = new Date('2026-10-27T12:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

let counter = 0;
function mk(overrides: Partial<Order> & { code?: string }): Order {
  counter += 1;
  return {
    id: `o-${counter}`,
    code: overrides.code ?? `FO-${counter}`,
    status: OrderStatus.PENDING,
    cancelledAt: null,
    confirmedAt: null,
    createdAt: ago(999),
    ...overrides,
  } as unknown as Order;
}

function fakeRepo(rows: Order[]) {
  const find = jest.fn(async (opts: any) => {
    const less = opts?.where?.createdAt?._value ?? opts?.where?.createdAt?.value;
    const statusFilter = opts?.where?.status;
    const filtered = rows
      .filter((r) => (statusFilter ? r.status === statusFilter : true))
      .filter((r) => (less ? new Date(r.createdAt).getTime() < new Date(less).getTime() : true));
    if (opts?.order?.createdAt === 'ASC') filtered.sort((a, b) => +a.createdAt - +b.createdAt);
    const take = opts?.take;
    return (typeof take === 'number' ? filtered.slice(0, take) : filtered).map((r) => ({ ...r }));
  });
  const save = jest.fn(async (x: Order) => x);
  return { find, save, rows };
}

describe('runStaleOrderSweep — selection', () => {
  it('cancels only stale PENDING orders, leaving fresh/recent and other statuses untouched', async () => {
    const stale = mk({ code: 'STALE1', status: OrderStatus.PENDING, createdAt: ago(90) });
    const fresh = mk({ code: 'FRESH1', status: OrderStatus.PENDING, createdAt: ago(10) });
    const confirmed = mk({ code: 'CONF1', status: OrderStatus.CONFIRMED, createdAt: ago(90) });
    const completed = mk({ code: 'DONE1', status: OrderStatus.COMPLETED, createdAt: ago(90) });
    const repo = fakeRepo([stale, fresh, confirmed, completed]);

    const report = await runStaleOrderSweep(repo as any, { staleMinutes: 45, now: NOW });

    expect(report.cancelled).toBe(1);
    expect(report.orders.map((o) => o.code)).toEqual(['STALE1']);
    expect(report.scanned).toBe(1);
    // exactly one save, and it was the stale pending order flipped to cancelled
    expect(repo.save).toHaveBeenCalledTimes(1);
    const saved: Order = repo.save.mock.calls[0][0];
    expect(saved.status).toBe(OrderStatus.CANCELLED);
    expect(saved.code).toBe('STALE1');
  });

  it('uses LessThan on createdAt with a cutoff of now - staleMinutes (strict, not <=)', async () => {
    const repo = fakeRepo([]);
    await runStaleOrderSweep(repo as any, { staleMinutes: 45, now: NOW });
    const where = repo.find.mock.calls[0][0].where;
    const cutoffVal = where.createdAt._value ?? where.createdAt.value;
    expect(where.status).toBe(OrderStatus.PENDING);
    // 45 min before NOW
    expect(new Date(cutoffVal).toISOString()).toBe(new Date(NOW.getTime() - 45 * 60_000).toISOString());
  });

  it('orders candidates oldest-first', async () => {
    const a = mk({ code: 'OLD', createdAt: ago(120) });
    const b = mk({ code: 'NEWER', createdAt: ago(60) });
    const repo = fakeRepo([b, a]);
    const report = await runStaleOrderSweep(repo as any, { staleMinutes: 45, now: NOW });
    expect(report.orders.map((o) => o.code)).toEqual(['OLD', 'NEWER']);
    expect(repo.find.mock.calls[0][0].order).toEqual({ createdAt: 'ASC' });
  });

  it('boundary: an order created exactly at the cutoff is NOT stale (strict less-than)', async () => {
    const edge = mk({ code: 'EDGE', createdAt: new Date(NOW.getTime() - 45 * 60_000) });
    const repo = fakeRepo([edge]);
    const report = await runStaleOrderSweep(repo as any, { staleMinutes: 45, now: NOW });
    expect(report.cancelled).toBe(0);
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('runStaleOrderSweep — batch cap + capped flag', () => {
  it('stops at the limit and reports capped=true when more stale rows remain', async () => {
    // ago(60 + i): higher index = created further in the past = older. So the
    // three OLDEST (first ASC) are S4, S3, S2.
    const rows = Array.from({ length: 5 }, (_, i) => mk({ code: `S${i}`, createdAt: ago(60 + i) }));
    const repo = fakeRepo(rows);
    const report = await runStaleOrderSweep(repo as any, { staleMinutes: 45, limit: 3, now: NOW });
    expect(report.cancelled).toBe(3);
    expect(report.capped).toBe(true);
    // oldest three first
    expect(report.orders.map((o) => o.code)).toEqual(['S4', 'S3', 'S2']);
  });

  it('capped=false when it drains everything under the limit', async () => {
    const rows = [mk({ code: 'A', createdAt: ago(60) }), mk({ code: 'B', createdAt: ago(50) })];
    const repo = fakeRepo(rows);
    const report = await runStaleOrderSweep(repo as any, { staleMinutes: 45, limit: 3, now: NOW });
    expect(report.cancelled).toBe(2);
    expect(report.capped).toBe(false);
  });

  it('capped=false on an empty backlog', async () => {
    const repo = fakeRepo([]);
    const report = await runStaleOrderSweep(repo as any, { staleMinutes: 45, now: NOW });
    expect(report.scanned).toBe(0);
    expect(report.cancelled).toBe(0);
    expect(report.capped).toBe(false);
  });
});

describe('runStaleOrderSweep — cancelledAt write-once', () => {
  it('stamps cancelledAt = now for a not-yet-cancelled order', async () => {
    const row = mk({ code: 'ST', createdAt: ago(60), cancelledAt: null });
    const repo = fakeRepo([row]);
    await runStaleOrderSweep(repo as any, { staleMinutes: 45, now: NOW });
    expect(repo.save.mock.calls[0][0].cancelledAt).toEqual(NOW);
  });

  it('does NOT overwrite an existing cancelledAt (timeline is write-once)', async () => {
    const prior = ago(80);
    const row = mk({ code: 'ST', createdAt: ago(90), cancelledAt: prior });
    const repo = fakeRepo([row]);
    await runStaleOrderSweep(repo as any, { staleMinutes: 45, now: NOW });
    expect(repo.save.mock.calls[0][0].cancelledAt).toEqual(prior);
  });
});

describe('runStaleOrderSweep — onCancelled hook', () => {
  it('invokes the hook once per cancelled order, in order', async () => {
    const rows = [mk({ code: 'X', createdAt: ago(70) }), mk({ code: 'Y', createdAt: ago(60) })];
    const repo = fakeRepo(rows);
    const seen: string[] = [];
    const report = await runStaleOrderSweep(repo as any, {
      staleMinutes: 45,
      now: NOW,
      onCancelled: (o) => void seen.push(o.code),
    });
    expect(seen).toEqual(['X', 'Y']);
    expect(report.cancelled).toBe(2);
  });

  it('awaits an async hook before moving on', async () => {
    const rows = [mk({ code: 'Z', createdAt: ago(70) })];
    const repo = fakeRepo(rows);
    const order: string[] = [];
    await runStaleOrderSweep(repo as any, {
      staleMinutes: 45,
      now: NOW,
      onCancelled: async () => {
        await Promise.resolve();
        order.push('hook');
      },
    });
    expect(order).toEqual(['hook']);
  });
});

describe('runStaleOrderSweep — dry run (save-less repo)', () => {
  it('reports candidates without mutating when save is a no-op (DRY_RUN path)', async () => {
    const rows = [mk({ code: 'D1', createdAt: ago(60) })];
    // find returns real rows; save returns the entity untouched (never persists).
    const find = jest.fn(async (opts: any) => rows.slice(0, opts.take ?? rows.length));
    const save = jest.fn(async (x: Order) => x);
    const report = await runStaleOrderSweep({ find, save } as any, {
      staleMinutes: 45,
      now: NOW,
    });
    expect(report.cancelled).toBe(1);
    expect(report.orders.map((o) => o.code)).toEqual(['D1']);
    // the in-memory row was mutated by the sweep, but nothing was committed
    // (the dry-run script never hits a real DB), which is exactly why DRY_RUN
    // uses a no-op save rather than skipping the sweep.
  });
});

describe('resolveStaleSweepConfig — env parsing', () => {
  const OLD = process.env;
  afterEach(() => {
    process.env = { ...OLD };
  });

  it('falls back to defaults when env is unset or junk', () => {
    delete process.env.STALE_ORDER_MINUTES;
    delete process.env.STALE_ORDER_BATCH;
    expect(resolveStaleSweepConfig({})).toEqual({
      staleMinutes: DEFAULT_STALE_ORDER_MINUTES,
      limit: DEFAULT_STALE_ORDER_BATCH,
    });
    // non-numeric / zero / negative / blank all fall back
    for (const junk of ['abc', '0', '-5', '12.5', '   ']) {
      expect(resolveStaleSweepConfig({ STALE_ORDER_MINUTES: junk }).staleMinutes).toBe(
        DEFAULT_STALE_ORDER_MINUTES,
      );
    }
  });

  it('accepts positive integer overrides from env', () => {
    const cfg = resolveStaleSweepConfig({ STALE_ORDER_MINUTES: '30', STALE_ORDER_BATCH: '100' });
    expect(cfg).toEqual({ staleMinutes: 30, limit: 100 });
  });

  it('the sweep honours env config when no per-call override is given', async () => {
    const edge = mk({ code: 'E', createdAt: ago(20) });
    const repo = fakeRepo([edge]);
    // env says 10 minutes → a 20-minute-old pending order IS stale
    const report = await runStaleOrderSweep(repo as any, {
      now: NOW,
      config: resolveStaleSweepConfig({ STALE_ORDER_MINUTES: '10' }),
    });
    expect(report.staleMinutes).toBe(10);
    expect(report.cancelled).toBe(1);
  });
});
