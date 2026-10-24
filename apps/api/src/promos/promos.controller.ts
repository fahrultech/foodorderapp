import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PromosService } from './promos.service';
import { ValidatePromoDto } from './dto/validate-promo.dto';

/**
 * Promo preview endpoint. Public (no JWT) because checkout is guest-allowed —
 * it only ever reveals whether a *public* code would apply to a cart the
 * caller already has; order creation re-evaluates server-side regardless.
 * Always 200: `{ valid, ... }` carries the verdict instead of an HTTP error,
 * so the UI can show the reason inline without exception plumbing.
 */
@Controller('promos')
@ApiTags('promos')
export class PromosController {
  constructor(private readonly service: PromosService) {}

  @Post('validate')
  @ApiOperation({ summary: 'Preview a promo code against a cart', description: 'Public: checkout is guest-allowed. Answers 200 even for invalid codes — the `{ valid, reason?, ... }` body carries the verdict so the UI can show it inline. Order creation re-evaluates server-side regardless.' })
  validate(@Body() dto: ValidatePromoDto) {
    return this.service.preview(dto.code, dto.restaurantId, dto.subtotalCents);
  }
}
