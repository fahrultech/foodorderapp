import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, Matches, Max, Min } from 'class-validator';

/**
 * Body for POST /promos/validate — a live "will this code work on my cart?"
 * preview. Everything here must carry a class-validator decorator: the global
 * ValidationPipe (whitelist: true) silently strips undecorated properties.
 */
export class ValidatePromoDto {
  /** Case-insensitive; the service uppercases before lookup. */
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9_-]{2,24}$/, { message: 'code looks invalid' })
  code: string;

  /** Preview is always in the context of one restaurant + cart subtotal. */
  @IsString()
  @IsNotEmpty()
  restaurantId: string;

  /** Client's believed subtotal in integer cents; purely a preview input —
   *  the real evaluation at order time recomputes the subtotal server-side. */
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  @Type(() => Number)
  subtotalCents: number;
}
