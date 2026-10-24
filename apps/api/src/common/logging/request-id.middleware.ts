import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from './request-context';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Inbound ids are echoed back to clients and embedded verbatim in log
 * lines, so they must be short and opaque: no colons, quotes, spaces or
 * newlines (log-injection guard). Anything else is replaced by a fresh UUID.
 */
const SAFE_INBOUND = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Global middleware registered before the rest of the request pipeline:
 * - assigns a correlation id (reusing a safe inbound `X-Request-Id` when
 *   a trusted caller sent one, else a fresh UUID v4),
 * - exposes it as `req.id` so pino-http reuses it instead of re-generating,
 * - echoes it on the response so clients/support can quote one id per issue,
 * - activates the AsyncLocalStorage context for the whole request chain.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers['x-request-id'];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const reqId = candidate && SAFE_INBOUND.test(candidate) ? candidate : randomUUID();
  (req as Request & { id?: string }).id = reqId;
  res.setHeader(REQUEST_ID_HEADER, reqId);
  runWithRequestContext({ reqId }, next);
}
