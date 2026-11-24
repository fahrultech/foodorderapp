import { DataSource } from 'typeorm';
import { RestockBacklogObserver } from './restock-backlog.observer';
import { DEFAULT_RESTOCK_REPAIR_GRACE_MINUTES } from '../../orders/stock-restock-repair';

/**
 * The Phase-14 observation supplier: ONE whole-table orphan count, never
 * throwing. These specs pin the three honesty properties the alert engine
 * documents: a successful read carries the count + the resolved grace,
 * ANY read failure degrades to `backlog: null + storeError: true` (never
 * a fabricated zero, never a rethrow into the caller's request path), and
 * the cutoff handed to the shared predicate is exactly "now minus the
 * configured repair grace" so the alert number is the drainable backlog.
 */

const envRestore: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined) {
  envRestore[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
afterEach(() => {
  for (const [k, v] of Object.entries(envRestore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function fake(query: jest.Mock) {
  const dataSource = { manager: { query } } as unknown as DataSource;
  return { observer: new RestockBacklogObserver(dataSource), query };
}

describe('RestockBacklogObserver', () => {
  it('healthy read: carries count + grace, cutoff = now - graceMinutes (tolerance window)', async () => {
    setEnv('RESTOCK_REPAIR_GRACE_MINUTES', '10');
    const before = Date.now();
    const { observer, query } = fake(jest.fn(async () => [[{ n: 2 }], 1]));
    const input = await observer.input();
    expect(input).toEqual({ backlog: 2, graceMinutes: 10 });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    const cutoff = params[0] as Date;
    const window = before - cutoff.getTime();
    expect(window).toBeGreaterThanOrEqual(9 * 60_000);
    expect(window).toBeLessThanOrEqual(11 * 60_000);
  });

  it('garbage/blank grace falls back to the DEFAULT grace (never a typo-driven cutoff)', async () => {
    setEnv('RESTOCK_REPAIR_GRACE_MINUTES', 'ten');
    const { observer } = fake(jest.fn(async () => [[{ n: 0 }], 1]));
    const input = await observer.input();
    expect(input).toEqual({ backlog: 0, graceMinutes: DEFAULT_RESTOCK_REPAIR_GRACE_MINUTES });
  });

  it('a FAILING count degrades to storeError, NEVER throws into the caller', async () => {
    setEnv('RESTOCK_REPAIR_GRACE_MINUTES', undefined);
    const { observer } = fake(jest.fn(async () => {
      throw new Error('relation orders missing');
    }));
    await expect(observer.input()).resolves.toEqual({
      backlog: null,
      graceMinutes: DEFAULT_RESTOCK_REPAIR_GRACE_MINUTES,
      storeError: true,
    });
  });
});
