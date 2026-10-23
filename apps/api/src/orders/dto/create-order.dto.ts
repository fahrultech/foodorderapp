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

export class CreateOrderItemDto {
  @IsString()
  @IsNotEmpty()
  menuItemId: string;

  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  quantity: number;
}

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  restaurantId: string;

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
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  customerName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9 ()-]{7,20}$/, { message: 'contactPhone looks invalid' })
  contactPhone?: string;

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
  @IsOptional()
  @IsUUID('4', { message: 'deliveryAddressId must be a valid saved-address id' })
  deliveryAddressId?: string;

  @IsOptional()
  @IsString()
  note?: string;

  /**
   * Optional promo code. NOT trusted: the server re-evaluates it against the
   * recomputed subtotal at create time (see PromosService.evaluate) and 400s
   * the whole order if it does not apply. Snapshot + discount are stored on
   * the order so receipts show what was actually taken off.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{2,24}$/, { message: 'promoCode looks invalid' })
  promoCode?: string;
}
