import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
  @ApiProperty({ maxLength: 40, example: 'Home' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  label: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  recipientName: string;

  @ApiProperty({ pattern: '\\+?[0-9 ()-]{7,20}' })
  @IsString()
  @Matches(ADDRESS_PHONE_PATTERN, { message: 'phone looks invalid' })
  phone: string;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  address: string;

  @ApiPropertyOptional({ description: 'Create-only; promote afterwards via POST /users/me/addresses/{id}/default' })
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
  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  label?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  recipientName?: string;

  @ApiPropertyOptional({ pattern: '\\+?[0-9 ()-]{7,20}' })
  @IsOptional()
  @IsString()
  @Matches(ADDRESS_PHONE_PATTERN, { message: 'phone looks invalid' })
  phone?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  address?: string;
}
