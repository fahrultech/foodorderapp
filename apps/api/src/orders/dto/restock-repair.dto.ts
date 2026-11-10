import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DEFAULT_RESTOCK_REPAIR_BATCH } from '../stock-restock-repair';

/**
 * Optional overrides for the admin restock-repair pass
 * (POST /orders/ops/restock-repair) — same shape rules as CancelStaleDto.
 * Every property carries a validator decorator — with the global
 * ValidationPipe (`whitelist: true`) an undecorated field would be stripped,
 * and `forbidUnknownValues: true` rejects a body of unknown keys. Query/body
 * params arrive as strings, so the numeric fields need `@Type(() => Number)`
 * for the transform pipe to coerce before the integer checks run.
 *
 * `@IsOptional()` is REQUIRED, not just cosmetic: without it class-validator
 * still applies `@IsInt/@Min/@Max` to an *absent* (undefined) value and fails
 * the whole body — an admin running with no overrides (`{}`) would get a
 * spurious 400. With it, an absent field is skipped and a present field is
 * still fully validated.
 *
 * Bounds: grace window 1 minute (aggressive operator drain) .. 7 days;
 * batch capped at the DEFAULT_RESTOCK_REPAIR_BATCH ceiling per manual run.
 */
export class RestockRepairDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 10080,
    description:
      'Override the crash grace window (minutes) for this run: only orders last touched this long ago are repaired. Omit to use RESTOCK_REPAIR_GRACE_MINUTES (default 10).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'graceMinutes must be an integer number of minutes' })
  @Min(1)
  @Max(10080)
  graceMinutes?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: DEFAULT_RESTOCK_REPAIR_BATCH,
    description: `Override the max orders to repair this run (1..${DEFAULT_RESTOCK_REPAIR_BATCH}). Omit to use RESTOCK_REPAIR_BATCH (default ${DEFAULT_RESTOCK_REPAIR_BATCH}).`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1)
  @Max(DEFAULT_RESTOCK_REPAIR_BATCH)
  limit?: number;
}
