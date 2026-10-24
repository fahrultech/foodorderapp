import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, Matches, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for POST /promos/validate — a live "will this code work on my cart?"
 * preview. Everything here must carry a class-validator decorator: the global
 * ValidationPipe (whitelist: true) silently strips undecorated properties.
 */
export class ValidatePromoDto {
  /** Case-insensitive; the service uppercases before lookup. */
  @ApiProperty({ pattern: '[A-Za-z0-9_-]{2,24}', example: 'WELCOME10' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9_-]{2,24}$/, { message: 'code looks invalid' })
  code: string;

  /** Preview is always in the context of one restaurant + cart subtotal. */
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  restaurantId: string;

  /** Client's believed subtotal in integer cents; purely a preview input —
   *  the real evaluation at order time recomputes the subtotal server-side. */
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 100000000, description: 'Integer cents. Preview only — the real evaluation at order time recomputes the subtotal server-side.' })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  @Type(() => Number)
  subtotalCents: number;
}
