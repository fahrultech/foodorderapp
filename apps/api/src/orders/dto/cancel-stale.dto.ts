import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DEFAULT_STALE_ORDER_BATCH } from '../stale-order-sweep';

/**
 * Optional overrides for the admin stale-order sweep (POST /orders/ops/cancel-stale).
 * Every property carries a validator decorator — with the global
 * ValidationPipe (`whitelist: true`) an undecorated field would be stripped,
 * and `forbidUnknownValues: true` rejects a body of unknown keys. Query/body
 * params arrive as strings, so the numeric fields need `@Type(() => Number)`
 * for the transform pipe to coerce before the integer checks run.
 *
 * `@IsOptional()` is REQUIRED, not just cosmetic: without it class-validator
 * still applies `@IsInt/@Min/@Max` to an *absent* (undefined) value and fails
 * the whole body — so an admin running with no overrides (`{}`) would get a
 * spurious 400. With it, an absent field is skipped and a present field is
 * still fully validated. (Same reason ListMyOrdersDto decorates its optional
 * page/limit the same way.)
 *
 * Bounds are wide but finite: a 0/negative/absurd window is a fat-finger, not
 * a policy. Max stale window = 7 days; max batch = the DEFAULT_STALE_ORDER_BATCH
 * ceiling a single manual run may sweep.
 */
export class CancelStaleDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 10080,
    description:
      'Override the pending-abandonment window (minutes) for this run. Omit to use STALE_ORDER_MINUTES (default 45).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'staleMinutes must be an integer number of minutes' })
  @Min(1)
  @Max(10080)
  staleMinutes?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: DEFAULT_STALE_ORDER_BATCH,
    description: `Override the max orders to cancel this run (1..${DEFAULT_STALE_ORDER_BATCH}). Omit to use STALE_ORDER_BATCH (default ${DEFAULT_STALE_ORDER_BATCH}).`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1)
  @Max(DEFAULT_STALE_ORDER_BATCH)
  limit?: number;
}
