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

/**
 * Owner creates a dish under `POST /restaurants/:restaurantId/menu`.
 * `restaurantId` comes from the URL — never the body — and `id`/timestamps
 * are not settable. Money stays integer cents.
 */
export class CreateMenuItemDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'name must contain non-whitespace characters' })
  @MaxLength(120)
  name: string;

  @IsInt()
  @Min(1)
  @Max(10000000)
  priceCents: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  prepMinutes?: number;

  /** Optional: create the dish in draft (unavailable) state. */
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
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'name must contain non-whitespace characters' })
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000000)
  priceCents?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  prepMinutes?: number;
}

/** Dedicated availability toggle — the whole DTO is one boolean. */
export class UpdateAvailabilityDto {
  @IsBoolean()
  isAvailable: boolean;
}
