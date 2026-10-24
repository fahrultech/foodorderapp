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

/**
 * Owner creates a dish under `POST /restaurants/:restaurantId/menu`.
 * `restaurantId` comes from the URL — never the body — and `id`/timestamps
 * are not settable. Money stays integer cents.
 */
export class CreateMenuItemDto {
  @ApiProperty({ maxLength: 120, example: 'Nasi Goreng Spesial' })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'name must contain non-whitespace characters' })
  @MaxLength(120)
  name: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 10000000, description: 'Price in integer cents' })
  @IsInt()
  @Min(1)
  @Max(10000000)
  priceCents: number;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ maxLength: 60, example: 'Mains' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 240 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  prepMinutes?: number;

  /** Optional: create the dish in draft (unavailable) state. */
  @ApiPropertyOptional({ description: 'Defaults to available (true) when omitted' })
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}

/**
 * Owner edit of dish content. Availability is a separate first-class route
 * (`PATCH /menu/items/:id/availability`); ownership link (`restaurantId`)
 * is not editable — a dish never moves between restaurants via PATCH.
 */
export class UpdateMenuItemDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'name must contain non-whitespace characters' })
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 10000000, description: 'Price in integer cents' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000000)
  priceCents?: number;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 240 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  prepMinutes?: number;
}

/** Dedicated availability toggle — the whole DTO is one boolean. */
export class UpdateAvailabilityDto {
  @ApiProperty()
  @IsBoolean()
  isAvailable: boolean;
}
