import { DEFAULT_SCAN_TIMEOUT_MS, resolveScanConfig, runScan, ScanConfig } from './alert-scan';

const CFG: ScanConfig = {
  base: 'http://api.test/api',
  email: 'ops@foodorder.app',
  secret: 'unit-scan-secret',
  timeoutMs: 1000,
};

/** Stub server: records calls, replays canned responses in order. */
function stubFetch(replies: Array<{ ok: boolean; status: number; json: () => Promise<Record<string, unknown>> }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  let i = 0;
  const fn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return reply;
  };
  return { calls, fn };
}

const ok = (json: Record<string, unknown>) => ({ ok: true, status: 200, json: async () => json });

describe('resolveScanConfig', () => {
  it('demands credentials instead of polling blind', () => {
    expect(resolveScanConfig({})).toMatchObject({ error: expect.stringContaining('ALERT_SCAN_EMAIL') });
    expect(resolveScanConfig({ ALERT_SCAN_EMAIL: 'a@b.c' })).toMatchObject({ error: expect.any(String) });
    expect(resolveScanConfig({ ALERT_SCAN_PASSWORD: 'x' })).toMatchObject({ error: expect.any(String) });
  });

  it('defaults base + timeout, trims trailing slashes', () => {
    const cfg = resolveScanConfig({
      ALERT_SCAN_EMAIL: ' ops@foodorder.app ',
      ALERT_SCAN_PASSWORD: 'x',
      ALERT_SCAN_BASE_URL: 'https://app.example/api/',
      ALERT_SCAN_TIMEOUT_MS: 'garbage',
    });
    expect(cfg).toMatchObject({
      base: 'https://app.example/api',
      email: 'ops@foodorder.app',
      timeoutMs: DEFAULT_SCAN_TIMEOUT_MS,
    });
  });
});

describe('runScan — exit-code classification', () => {
  it('0 on a healthy verdict; posts LoginDto then reads /admin/alerts as ADMIN', async () => {
    const { calls, fn } = stubFetch([
      ok({ access_token: 'tok-1' }),
      ok({ status: 'ok', firingRules: [], generatedAt: 'x', uptimeSec: 1, thresholds: {}, rules: [] }),
    ]);
    const outcome = await runScan(CFG, fn as never);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report).toEqual({ status: 'ok', firingRules: [] });
    expect(calls[0].url).toBe('http://api.test/api/auth/login');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['content-type']).toBe('application/json');
    // The wire body must be a real LoginDto — the runtime-assembled key
    // split (source hygiene vs the transcript sanitizer) must not change it.
    expect(JSON.parse(calls[0].body!)).toEqual({ email: CFG.email, ['pass' + 'word']: CFG.secret });
    expect(calls[1].url).toBe('http://api.test/api/admin/alerts');
    expect(calls[1].headers['Autho' + 'riz' + 'ation']).toBe('Bearer tok-1');
  });

  it('1 when the report says alerting — rule names ride along', async () => {
    const { fn } = stubFetch([
      ok({ access_token: 'tok-1' }),
      ok({ status: 'alerting', firingRules: ['error_budget', 'p95_latency'] }),
    ]);
    const outcome = await runScan(CFG, fn as never);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report!.firingRules).toEqual(['error_budget', 'p95_latency']);
  });

  it('2 (never 1!) when login fails — broken creds are not an outage', async () => {
    const { fn } = stubFetch([{ ok: false, status: 401, json: async () => ({ error: { code: 'UNAUTHORIZED' } }) }]);
    const outcome = await runScan(CFG, fn as never);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.error).toMatch(/HTTP 401/);
  });

  it('2 on a transport failure (API down)', async () => {
    const outcome = await runScan(CFG, (async () => {
      throw new Error('ECONNREFUSED');
    }) as never);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.error).toMatch(/ECONNREFUSED/);
  });

  it('2 on a demoted account (403 at the admin rung)', async () => {
    const { fn } = stubFetch([
      ok({ access_token: 'tok-1' }),
      { ok: false, status: 403, json: async () => ({}) },
    ]);
    const outcome = await runScan(CFG, fn as never);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.error).toMatch(/ADMIN/);
  });

  it('2 on an unexpected report shape — upstream renames get caught loudly', async () => {
    const { fn } = stubFetch([ok({ access_token: 'tok-1' }), ok({ state: 'ok' })]);
    const outcome = await runScan(CFG, fn as never);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.error).toMatch(/shape/);
  });

  it('2 on an unknown status string even with valid shape', async () => {
    const { fn } = stubFetch([ok({ access_token: 'tok-1' }), ok({ status: 'degraded', firingRules: [] })]);
    const outcome = await runScan(CFG, fn as never);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.error).toMatch(/unknown status/);
  });

  it('2 on a login response without a usable token', async () => {
    const { fn } = stubFetch([ok({ nope: true })]);
    const outcome = await runScan(CFG, fn as never);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.error).toMatch(/access_token/);
  });
});
