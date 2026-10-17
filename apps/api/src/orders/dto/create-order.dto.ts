import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
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

  @IsString()
  @IsNotEmpty()
  customerName: string;

  @IsString()
  @Matches(/^\+?[0-9 ()-]{7,20}$/, { message: 'contactPhone looks invalid' })
  contactPhone: string;

  @IsString()
  @IsNotEmpty()
  deliveryAddress: string;

  @IsOptional()
  @IsString()
  note?: string;
}
