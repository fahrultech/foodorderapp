import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Phone pattern shared with CreateOrderDto.contactPhone — one definition of
 * "dialable" across the API. Length cap matches the entity column (32).
 */
export const ADDRESS_PHONE_PATTERN = /^\+?[0-9 ()-]{7,20}$/;

/**
 * Body of `POST /users/me/addresses`. `userId` is not a DTO field — it comes
 * from the JWT subject, and the whitelist strips anything without a decorator.
 * `isDefault` is create-only (first row is forced default by the service);
 * moving the default afterwards goes through POST /:id/default, which keeps
 * the exactly-one-default invariant in one obvious place.
 */
export class CreateDeliveryAddressDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  label: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  recipientName: string;

  @IsString()
  @Matches(ADDRESS_PHONE_PATTERN, { message: 'phone looks invalid' })
  phone: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  address: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/**
 * Body of `PATCH /users/me/addresses/:id`. Every field optional; the service
 * rejects an empty patch with 400 (same convention as PATCH /users/me) and
 * deliberately does NOT accept `isDefault`/`userId`/`id` — whitelist strips
 * them, the default route owns the flag.
 */
export class UpdateDeliveryAddressDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  label?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  recipientName?: string;

  @IsOptional()
  @IsString()
  @Matches(ADDRESS_PHONE_PATTERN, { message: 'phone looks invalid' })
  phone?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  address?: string;
}
