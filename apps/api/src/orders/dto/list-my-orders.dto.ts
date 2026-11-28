import { Type, Transform } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { OrderStatus } from '../order.entity';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/**
 * Query string for GET /orders/my. Query params arrive as strings, so the
 * numeric fields need @Type(() => Number) for the transform pipe to coerce.
 */
export class ListMyOrdersDto {
  @ApiPropertyOptional({ enum: OrderStatus, enumName: 'OrderStatus' })
  @IsOptional()
  @IsEnum(OrderStatus, {
    message: 'status must be one of: pending, confirmed, preparing, delivering, completed, cancelled',
  })
  status?: OrderStatus;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}

/** Blank wire means UNSET (blankToUndefined doctrine): `?from=` behaves like
 *  the param never existed, never a 400 on a harmless browser artifact. */
const blankToUnset = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * GET /orders/my additionally accepts a CLOSED date range over `createdAt`.
 * Kept a SUBCLASS so the owner inbox and driver inbox — which share the base
 * status/page/limit contract but do NOT filter by date — can never
 * accept-and-ignore silently: whitelist:true strips `from`/`to` there.
 * `from`/`to` are ISO-8601 strings (date-only or full datetime, UTC
 * semantics straight off the parse); the range is validated closed
 * (`from <= to`) in the service-side pure helper, never here — class-level
 * cross-field validators would 400 with the generic pipe message, while an
 * inverted range deserves the specific `from must not be after to`.
 */
export class ListMyOrdersRangeDto extends ListMyOrdersDto {
  @ApiPropertyOptional({
    type: 'string',
    format: 'date-time',
    description:
      'Include only orders created at or after this instant (ISO-8601, date-only or datetime; blank means unset). Served by the (userId, createdAt) index.',
    example: '2026-11-01T00:00:00.000Z',
  })
  @IsOptional()
  @Transform(blankToUnset)
  @IsISO8601({}, { message: 'from must be an ISO-8601 date or datetime' })
  from?: string;

  @ApiPropertyOptional({
    type: 'string',
    format: 'date-time',
    description: 'Include only orders created at or before this instant (ISO-8601; blank means unset). Must not precede `from`.',
    example: '2026-11-28T23:59:59.999Z',
  })
  @IsOptional()
  @Transform(blankToUnset)
  @IsISO8601({}, { message: 'to must be an ISO-8601 date or datetime' })
  to?: string;
}
