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

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateRestaurantDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  /** Optional custom slug; auto-derived from name when omitted. */
  @IsOptional()
  @Matches(SLUG_RE, {
    message: 'slug must be lowercase kebab-case (a-z, 0-9, hyphens)',
  })
  @MaxLength(80)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  cuisine?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  deliveryFeeCents?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000000)
  minOrderCents?: number;

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
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  cuisine?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  deliveryFeeCents?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000000)
  minOrderCents?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  avgPrepMinutes?: number;

  @IsOptional()
  @IsBoolean()
  isOpen?: boolean;
}
