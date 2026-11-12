import type { NextFunction, Request, Response } from 'express';
import { RequestMetricsRegistry, routeKeyOf, shouldTrackUrl, statusClassOf, HISTOGRAM_BOUNDS_MS, type StatusClass } from './request-metrics';

/** Compact per-request summary folded into the pino access line. */
export interface MetricsLogSummary {
  /** Histogram bucket the duration landed in, e.g. "<=100ms" or ">10000ms". */
  bucket: string;
  status_class: StatusClass;
}

export function bucketLabel(durationMs: number): string {
  for (const b of HISTOGRAM_BOUNDS_MS) {
    if (durationMs <= b) return `<=${b}ms`;
  }
  return `>${HISTOGRAM_BOUNDS_MS[HISTOGRAM_BOUNDS_MS.length - 1]}ms`;
}

/**
 * Metrics capture as a plain Express middleware over a shared registry.
 *
 * ORDER-SENSITIVE: register BEFORE `createHttpLoggingMiddleware`. Both hook
 * `res.on('finish')`, and Node fires same-event listeners in registration
 * order — so this listener runs first, records the sample AND decorates
 * `res.metrics`, and only then does pino-http render its access line with
 * `customProps` reading that decoration. One JSON line per request carries
 * both the access fields and the metrics summary; there is no second log
 * stream. (Asserted by request-metrics.integration.spec.ts.)
 *
 * Long-lived responses (SSE) are accounted when the stream CLOSES — same
 * policy and same rationale as the access logger.
 */
export function createRequestMetricsMiddleware(registry: RequestMetricsRegistry) {
  return function requestMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!shouldTrackUrl(req.url)) {
      next();
      return;
    }
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // req.route is resolved by now (routing finished long before 'finish'),
      // so tracked routes key on the TEMPLATE, never the concrete path.
      registry.record(routeKeyOf(req), res.statusCode, durationMs);
      (res as Response & { metrics?: MetricsLogSummary }).metrics = {
        bucket: bucketLabel(durationMs),
        status_class: statusClassOf(res.statusCode),
      };
    });
    next();
  };
}
