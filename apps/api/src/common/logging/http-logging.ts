import type { Logger as PinoInstance } from 'pino';
import pinoHttp from 'pino-http';

/**
 * Access logging: exactly one structured JSON line per finished HTTP
 * request — method, url, status, duration in ms and the top-level `reqId`
 * set by `requestIdMiddleware` (pino-http reuses `req.id` and never
 * re-generates one, so access lines and app lines correlate 1:1).
 *
 * - Level by outcome: unhandled error or 5xx → `error`, 4xx → `warn`,
 *   otherwise `info`.
 * - `/api/health` is ignored so liveness probes don't drown the stream.
 * - Serializers are deliberately minimal: headers and bodies never reach
 *   the log (tokens live in headers; the root logger redacts them anyway,
 *   but we don't collect them in the first place).
 *
 * Register AFTER requestIdMiddleware. SSE streams stay open for a long
 * time and only log on close — intended, not a leak.
 */
export function createHttpLoggingMiddleware(logger: PinoInstance) {
  return pinoHttp({
    logger,
    customProps: (req) => ({ reqId: (req as { id?: string }).id }),
    autoLogging: {
      ignore: (req) => typeof req.url === 'string' && req.url.startsWith('/api/health'),
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
    serializers: {
      req: (req) => ({ method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  });
}
