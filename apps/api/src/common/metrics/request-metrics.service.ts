import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestMetricsRegistry } from './request-metrics';
import { createRequestMetricsMiddleware } from './request-metrics.middleware';
import {
  AlertReport,
  AlertThresholds,
  evaluateAlerts,
  resolveAlertThresholds,
  summarizeAlerts,
} from '../../ops/alerts';

export const DEFAULT_METRICS_LOG_INTERVAL_SEC = 60;

/**
 * Env parsing for METRICS_LOG_INTERVAL_SEC:
 * - unset / empty → default 60 s
 * - `0` → periodic fold DISABLED (the ADMIN snapshot route still works;
 *   an operator who only wants pull-based reads opts out of the log line)
 * - negative / garbage → default (a typo must NEVER crash boot: this is an
 *   observability knob, not a money-integrity gate)
 */
export function resolveIntervalSec(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw.trim() === '') return DEFAULT_METRICS_LOG_INTERVAL_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_METRICS_LOG_INTERVAL_SEC;
  return Math.floor(n);
}

/**
 * Nest wiring around the DI-free registry: owns the single in-process
 * instance the middleware records into and the ADMIN route reads from, and
 * folds a periodic aggregate snapshot into the SAME pino stream as the
 * access logs (`event: "request_metrics"`). The alerts loop reads either
 * the log lines or GET /admin/metrics — both come from one registry, so
 * they can never disagree.
 */
@Injectable()
export class RequestMetricsService implements OnModuleDestroy {
  readonly registry = new RequestMetricsRegistry();
  readonly intervalSec: number;
  /** Resolved ONCE at boot — thresholds are boot config, not hot-reloaded. */
  readonly alertThresholds: AlertThresholds;
  private readonly logger = new Logger(RequestMetricsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(config: ConfigService) {
    this.intervalSec = resolveIntervalSec(config.get<string>('METRICS_LOG_INTERVAL_SEC'));
    this.alertThresholds = resolveAlertThresholds({
      ALERT_5XX_RATE_PCT_MAX: config.get<string>('ALERT_5XX_RATE_PCT_MAX'),
      ALERT_P95_MS_MAX: config.get<string>('ALERT_P95_MS_MAX'),
      ALERT_MIN_REQUESTS: config.get<string>('ALERT_MIN_REQUESTS'),
    });
    if (this.intervalSec > 0) {
      this.timer = setInterval(() => this.logSnapshot(), this.intervalSec * 1000);
      // Never keep the event loop alive for a metrics heartbeat (tests, CLI shutdown).
      this.timer.unref();
    }
  }

  middleware(): (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => void {
    return createRequestMetricsMiddleware(this.registry);
  }

  snapshot() {
    return this.registry.snapshot();
  }

  /** Full alert report over the LIVE snapshot — the GET /admin/alerts route. */
  alerts(): AlertReport {
    return evaluateAlerts(this.registry.snapshot(), this.alertThresholds);
  }

  logSnapshot(): void {
    // PinoLoggerService merges the plain-object param into the JSON fields,
    // so this lands as ONE structured line, same stream as access logs.
    // The compact `alerts` verdict (session 86) lets a log-based alerter
    // read the SAME rule engine as GET /admin/alerts — no second engine.
    const metrics = this.registry.snapshot();
    const alerts = summarizeAlerts(evaluateAlerts(metrics, this.alertThresholds));
    this.logger.log('request metrics snapshot', { event: 'request_metrics', metrics, alerts });
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
