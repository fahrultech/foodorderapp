import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { OrderStatus } from '../order.entity';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/**
 * Query string for GET /orders/my. Query params arrive as strings, so the
 * numeric fields need @Type(() => Number) for the transform pipe to coerce.
 */
export class ListMyOrdersDto {
  @IsOptional()
  @IsEnum(OrderStatus, {
    message: 'status must be one of: pending, confirmed, preparing, delivering, completed, cancelled',
  })
  status?: OrderStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}
