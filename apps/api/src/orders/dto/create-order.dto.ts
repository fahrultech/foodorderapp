import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
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

  /**
   * Menu-option selections (Phase 5). NOT trusted like every money field:
   * the server re-checks each id against the dish's option groups (exists,
   * belongs to THIS dish, no duplicates, per-group min/max) and folds the
   * stored price deltas into the unit price itself. Unknown/foreign ids
   * 400 the whole order.
   */
  @ApiPropertyOptional({
    type: [String],
    description: 'Choice ids from the dish optionGroups in GET /restaurants/{id}/menu',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true, message: 'optionChoiceIds must be valid choice ids' })
  optionChoiceIds?: string[];
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

  /**
   * Receipt access proof (Phase 6 ownership fix). Optional at the API level
   * so existing clients keep working, but every order WITHOUT it has no
   * guest-view path on `GET /orders/:id` — the storefront checkout always
   * collects it. Normalized (trim + lowercase) by the service before save.
   */
  @ApiPropertyOptional({
    description: 'Contact email; doubles as the proof required to view a guest receipt. Stored lowercased.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(254)
  @IsEmail({}, { message: 'contactEmail looks invalid' })
  contactEmail?: string;

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
