import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  DEFAULT_ALERT_HISTORY_LIMIT,
  DEFAULT_ALERT_HISTORY_WINDOW_SEC,
  MAX_ALERT_HISTORY_LIMIT,
  MAX_ALERT_HISTORY_WINDOW_SEC,
  MIN_ALERT_HISTORY_LIMIT,
  MIN_ALERT_HISTORY_WINDOW_SEC,
} from '../../common/metrics/alert-verdicts.service';

/**
 * Query DTO for GET /admin/alerts/history (Phase 11 Ops: alert-verdict time
 * series). Every property carries a class-validator decorator — the global
 * ValidationPipe (whitelist: true) strips undecorated ones.
 *
 * Blank semantics (session-87 wire truth made explicit): the pipe
 * Number()-coerces these annotated params, so a present-but-empty
 * `?windowSec=` can reach validation as `''` OR as `0` depending on
 * decorator order inside class-transformer. BOTH blank shapes mean
 * "unset → use the default": 0 is below the legal minimum of every bound
 * here anyway, so mapping it to undefined never hides a valid value.
 * Junk (`abc` → NaN fails @IsInt) and out-of-range values (`windowSec=5`)
 * stay a LOUD 400 — a caller typo is never silently clamped over on the
 * wire. The service re-clamps both bounds for direct callers (defense in
 * depth, pinned in query-surface-audit).
 */
const blankOrZeroToUndefined = ({ value }: { value: unknown }): unknown =>
  (typeof value === 'string' && value.trim() === '') || value === 0 ? undefined : value;

export class AlertsHistoryQueryDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: MIN_ALERT_HISTORY_WINDOW_SEC,
    maximum: MAX_ALERT_HISTORY_WINDOW_SEC,
    default: DEFAULT_ALERT_HISTORY_WINDOW_SEC,
    description:
      'History window in seconds, ending now (default 86400 = full retention day; ' +
      '60..2592000). Empty or 0 = default.',
  })
  @Transform(blankOrZeroToUndefined)
  @IsOptional()
  @IsInt()
  @Min(MIN_ALERT_HISTORY_WINDOW_SEC)
  @Max(MAX_ALERT_HISTORY_WINDOW_SEC)
  @Type(() => Number)
  windowSec?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: MIN_ALERT_HISTORY_LIMIT,
    maximum: MAX_ALERT_HISTORY_LIMIT,
    default: DEFAULT_ALERT_HISTORY_LIMIT,
    description:
      'Max rows returned (default 288 = one day at the 300s tick; 1..2000). ' +
      'Empty or 0 = default. The trailing-alerting streak is a lower bound ' +
      'when it cuts off a run.',
  })
  @Transform(blankOrZeroToUndefined)
  @IsOptional()
  @IsInt()
  @Min(MIN_ALERT_HISTORY_LIMIT)
  @Max(MAX_ALERT_HISTORY_LIMIT)
  @Type(() => Number)
  limit?: number;
}
