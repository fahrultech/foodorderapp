import {
  IsBoolean,
  IsIn,
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

export const MENU_IMAGE_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const;
export type MenuImageContentType = (typeof MENU_IMAGE_CONTENT_TYPES)[number];
export const MENU_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

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

  /**
   * Stock guard (session 71): remaining sellable units. Omitted or null =
   * UNLIMITED (no decrement at order create). Validated integer >= 0; the
   * DB CHECK mirrors the bound. Order create decrements it atomically
   * inside its transaction and 409s the whole order when short.
   */
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    nullable: true,
    description: 'Sellable units; null/omitted = unlimited',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number | null;
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

  /**
   * Stock guard (session 71): a NUMBER sets the sellable-unit count, an
   * explicit `null` clears it back to UNLIMITED, an absent property leaves
   * it untouched — the standard three-way patch semantics of this DTO
   * (`@IsOptional()` skips null, so explicit nulls reach the service).
   */
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    nullable: true,
    description: 'Set stock (>= 0); null clears to unlimited; omitted = untouched',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number | null;
}

/** Dedicated availability toggle — the whole DTO is one boolean. */
export class UpdateAvailabilityDto {
  @ApiProperty()
  @IsBoolean()
  isAvailable: boolean;
}

/** Browser metadata used to bind a short-lived direct-to-object-storage PUT. */
export class CreateMenuImageUploadDto {
  @ApiProperty({ enum: MENU_IMAGE_CONTENT_TYPES, example: 'image/webp' })
  @IsIn(MENU_IMAGE_CONTENT_TYPES)
  contentType: MenuImageContentType;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: MENU_IMAGE_MAX_BYTES,
    description: 'Exact file size in bytes; maximum 5 MiB',
  })
  @IsInt()
  @Min(1)
  @Max(MENU_IMAGE_MAX_BYTES)
  sizeBytes: number;
}
