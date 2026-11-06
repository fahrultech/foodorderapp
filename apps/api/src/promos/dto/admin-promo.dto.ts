import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PromoDiscountType } from '../promo-code.entity';

/**
 * ADMIN bodies for promo-code management (Phase 5 "Coupons expiry + usage
 * caps"). Everything here must carry a class-validator decorator: the global
 * ValidationPipe (whitelist: true) silently strips undecorated properties.
 *
 * Null-vs-missing semantics on PATCH: `undefined` keeps the current value,
 * explicit `null` CLEARS the field (expiry or cap removed). @IsOptional skips
 * BOTH, so the service does the three-way interpretation.
 */

const CODE_PATTERN = /^[A-Za-z0-9_-]{2,24}$/;

export class CreatePromoDto {
  @ApiProperty({ pattern: '[A-Za-z0-9_-]{2,24}', example: 'FLASH3OFF' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @Matches(CODE_PATTERN, { message: 'code looks invalid' })
  code: string;

  @ApiProperty({ enum: PromoDiscountType })
  @IsEnum(PromoDiscountType)
  discountType: PromoDiscountType;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: 10_000_000,
    description: 'percent: percentage points (service enforces 1..100); fixed: cents off. Integer cents.',
  })
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  @Type(() => Number)
  valueCents: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, description: 'Ceiling for PERCENT discounts; ignored by FIXED.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  @Type(() => Number)
  maxDiscountCents?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, default: 0, description: 'Pre-discount subtotal gate, integer cents.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  @Type(() => Number)
  minSubtotalCents?: number;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({
    type: 'string',
    format: 'uuid',
    description: 'Restaurant scope; omit or null = platform-wide.',
  })
  @IsOptional()
  @IsUUID()
  restaurantId?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    type: 'string',
    format: 'date-time',
    description: 'Redemption window start (inclusive). Null/omit = usable immediately.',
  })
  @IsOptional()
  @IsISO8601()
  startsAt?: string | null;

  @ApiPropertyOptional({
    type: 'string',
    format: 'date-time',
    description: 'Redemption window end (exclusive). Null/omit = never expires.',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    description: 'Total redemption cap across all customers; null/omit = unlimited. 0 = immediately spent.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  @Type(() => Number)
  maxTotalUsages?: number | null;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    description: 'Per signed-in account redemption cap; null/omit = unlimited. Guest redemptions skip this gate (never capped per account).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  @Type(() => Number)
  maxPerUser?: number | null;
}

/** Every field optional; null clears expiry/caps. See class comment above. */
export class UpdatePromoDto {
  @ApiPropertyOptional({ pattern: '[A-Za-z0-9_-]{2,24}' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(CODE_PATTERN, { message: 'code looks invalid' })
  code?: string;

  @ApiPropertyOptional({ enum: PromoDiscountType })
  @IsOptional()
  @IsEnum(PromoDiscountType)
  discountType?: PromoDiscountType;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 10_000_000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  @Type(() => Number)
  valueCents?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  @Type(() => Number)
  maxDiscountCents?: number | null;

  @ApiPropertyOptional({ type: 'integer', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  @Type(() => Number)
  minSubtotalCents?: number;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string | null;

  @ApiPropertyOptional({ type: 'string', format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  restaurantId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: 'string', format: 'date-time', nullable: true })
  @IsOptional()
  @IsISO8601()
  startsAt?: string | null;

  @ApiPropertyOptional({ type: 'string', format: 'date-time', nullable: true })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  @Type(() => Number)
  maxTotalUsages?: number | null;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  @Type(() => Number)
  maxPerUser?: number | null;
}

/** Pagination for the ADMIN redemption ledger read. */
export class ListPromoUsagesDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  limit?: number;
}
