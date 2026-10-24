import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOperation,
  getSchemaPath,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiError,
  PromoInvalidResponse,
  PromoValidResponse,
} from '../common/swagger-response-models';
import { PromosService } from './promos.service';
import { ValidatePromoDto } from './dto/validate-promo.dto';

/**
 * Promo preview endpoint. Public (no JWT) because checkout is guest-allowed —
 * it only ever reveals whether a *public* code would apply to a cart the
 * caller already has; order creation re-evaluates server-side regardless.
 * Always 2xx (POST default 201): `{ valid, ... }` carries the verdict instead of
 * an HTTP error,
 * so the UI can show the reason inline without exception plumbing.
 */
@Controller('promos')
@ApiTags('promos')
export class PromosController {
  constructor(private readonly service: PromosService) {}

  @Post('validate')
  @ApiOperation({ summary: 'Preview a promo code against a cart', description: 'Public: checkout is guest-allowed. Answers SUCCESS even for invalid codes — the `{ valid, ... }` body carries the verdict so the UI can show it inline (an invalid code is NOT an HTTP error). Order creation re-evaluates server-side regardless.' })
  @ApiExtraModels(PromoValidResponse, PromoInvalidResponse)
  @ApiCreatedResponse({
    description: 'Nest default POST status (201). Verdict is in the body, never the status.',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(PromoValidResponse) },
        { $ref: getSchemaPath(PromoInvalidResponse) },
      ],
    },
  })
  @ApiError(400, 'Body failed validation (code/restaurantId/subtotalCents).')
  validate(@Body() dto: ValidatePromoDto) {
    return this.service.preview(dto.code, dto.restaurantId, dto.subtotalCents);
  }
}
