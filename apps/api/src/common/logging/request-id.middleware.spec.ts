import type { Request, Response } from 'express';
import { currentReqId } from './request-context';
import { REQUEST_ID_HEADER, requestIdMiddleware } from './request-id.middleware';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeReq(headers: Record<string, string | string[]> = {}): Request {
  return { headers } as unknown as Request;
}

function fakeRes(): { res: Response; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string | number | string[]) {
      headers[name] = String(value);
    },
  } as unknown as Response;
  return { res, headers };
}

function run(headers: Record<string, string | string[]> = {}) {
  const req = fakeReq(headers);
  const { res, headers: sent } = fakeRes();
  let nextCalled = false;
  let idInsideNext: string | undefined;
  requestIdMiddleware(req, res, () => {
    nextCalled = true;
    idInsideNext = currentReqId();
  });
  return { req, sent, nextCalled, idInsideNext };
}

describe('requestIdMiddleware', () => {
  it('generates a UUID v4 when no inbound header is present', () => {
    const { req, sent, nextCalled, idInsideNext } = run();
    expect(nextCalled).toBe(true);
    expect(sent[REQUEST_ID_HEADER]).toMatch(UUID_V4);
    expect((req as Request & { id?: string }).id).toBe(sent[REQUEST_ID_HEADER]);
    expect(idInsideNext).toBe(sent[REQUEST_ID_HEADER]);
  });

  it('reuses a safe inbound id verbatim', () => {
    const { sent, idInsideNext } = run({ 'x-request-id': 'trace-abc_123.def-X' });
    expect(sent[REQUEST_ID_HEADER]).toBe('trace-abc_123.def-X');
    expect(idInsideNext).toBe('trace-abc_123.def-X');
  });

  it('takes the first value of a duplicated header', () => {
    const { sent } = run({ 'x-request-id': ['first-id', 'second-id'] });
    expect(sent[REQUEST_ID_HEADER]).toBe('first-id');
  });

  it.each([
    ['spaces', 'has spaces'],
    ['injection chars', 'evil":"x'],
    ['newlines', 'a\nb'],
    ['too long', 'x'.repeat(65)],
    ['empty', ''],
  ])('replaces an unsafe inbound id (%s) with a fresh UUID', (_name, inbound) => {
    const { sent } = run({ 'x-request-id': inbound });
    expect(sent[REQUEST_ID_HEADER]).not.toBe(inbound);
    expect(sent[REQUEST_ID_HEADER]).toMatch(UUID_V4);
  });

  it('activates the request context only for the handler chain', () => {
    const { nextCalled } = run();
    expect(nextCalled).toBe(true);
    // After the middleware call stack unwinds, no context is leaked.
    expect(currentReqId()).toBeUndefined();
  });

  it('assigns distinct ids across requests', () => {
    const a = run().sent[REQUEST_ID_HEADER];
    const b = run().sent[REQUEST_ID_HEADER];
    expect(a).not.toBe(b);
  });
});
