import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateRestaurantDto {
  @ApiProperty({ maxLength: 120, example: 'Warung Nusantara' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  /** Optional custom slug; auto-derived from name when omitted. */
  @ApiPropertyOptional({ pattern: '[a-z0-9]+(?:-[a-z0-9]+)*', maxLength: 80, description: 'Lowercase kebab-case. Auto-derived from the name when omitted; a taken slug gets an -N suffix.' })
  @IsOptional()
  @Matches(SLUG_RE, {
    message: 'slug must be lowercase kebab-case (a-z, 0-9, hyphens)',
  })
  @MaxLength(80)
  slug?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ maxLength: 60, example: 'Indonesian' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  cuisine?: string;

  @ApiPropertyOptional({ maxLength: 60, example: 'Jakarta' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  city?: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 100000, default: 0, description: 'Integer cents' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  deliveryFeeCents?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 10000000, default: 0, description: 'Integer cents' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000000)
  minOrderCents?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 240, default: 30 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  avgPrepMinutes?: number;
}

/**
 * Owner edit of own restaurant. Intentionally omits `ownerId`, `slug` and
 * `rating` — ownership transfer, URL and reputation are not self-service.
 */
export class UpdateRestaurantDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  cuisine?: string;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  city?: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 100000, description: 'Integer cents' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  deliveryFeeCents?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 10000000, description: 'Integer cents' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000000)
  minOrderCents?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 240 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  avgPrepMinutes?: number;

  @ApiPropertyOptional({ description: 'Pause/resume accepting orders' })
  @IsOptional()
  @IsBoolean()
  isOpen?: boolean;
}
