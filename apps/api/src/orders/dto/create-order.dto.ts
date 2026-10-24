import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateOrderItemDto {
  @ApiProperty({ description: 'Dish id from GET /restaurants/{id} or the menu route' })
  @IsString()
  @IsNotEmpty()
  menuItemId: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 50 })
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  quantity: number;
}

export class CreateOrderDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  restaurantId: string;

  @ApiProperty({ type: [CreateOrderItemDto], minItems: 1 })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];

  /**
   * Contact fields are individually optional ONLY because a signed-in
   * customer may instead send `deliveryAddressId` — the server then copies
   * name/phone/address from the saved row (OrdersService enforces the
   * either/or: without an address id all three are required, 400).
   */
  @ApiPropertyOptional({ description: 'Required unless deliveryAddressId is given (then server-copied from the saved row)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  customerName?: string;

  @ApiPropertyOptional({ pattern: '\\+?[0-9 ()-]{7,20}', description: 'Required unless deliveryAddressId is given' })
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9 ()-]{7,20}$/, { message: 'contactPhone looks invalid' })
  contactPhone?: string;

  @ApiPropertyOptional({ description: 'Required unless deliveryAddressId is given' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  deliveryAddress?: string;

  /**
   * Saved-address id from the caller's address book (Phase 3). Trusted only
   * after the server resolves it against `userId` — the order stores TEXT
   * snapshots of recipientName/phone/address, so later book edits never
   * rewrite delivery history. Guests cannot use it (400), foreign/unknown
   * ids are 404 like every other `users/me` resource.
   */
  @ApiPropertyOptional({ format: 'uuid', description: 'Own saved-address id (authenticated customers only; guests get 400)' })
  @IsOptional()
  @IsUUID('4', { message: 'deliveryAddressId must be a valid saved-address id' })
  deliveryAddressId?: string;

  @ApiPropertyOptional({ description: 'Free-text note for the kitchen' })
  @IsOptional()
  @IsString()
  note?: string;

  /**
   * Optional promo code. NOT trusted: the server re-evaluates it against the
   * recomputed subtotal at create time (see PromosService.evaluate) and 400s
   * the whole order if it does not apply. Snapshot + discount are stored on
   * the order so receipts show what was actually taken off.
   */
  @ApiPropertyOptional({ pattern: '[A-Za-z0-9_-]{2,24}', description: 'Server re-validates against the recomputed subtotal and 400s the order if it does not apply' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{2,24}$/, { message: 'promoCode looks invalid' })
  promoCode?: string;
}
