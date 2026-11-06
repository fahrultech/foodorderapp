import { Body, Controller, Post, UseGuards } from '@nestjs/common';
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
import { CurrentUser } from '../common/current-user.decorator';
import { OptionalJwtAuthGuard } from '../common/optional-jwt-auth.guard';
import { PromosService } from './promos.service';
import { ValidatePromoDto } from './dto/validate-promo.dto';

/**
 * Promo preview endpoint. Public (no JWT required) because checkout is
 * guest-allowed — it only ever reveals whether a *public* code would apply
 * to a cart the caller already has; order creation re-evaluates server-side
 * regardless. A valid bearer token additionally applies the per-user usage
 * cap for that identity (guests can never be cap-blocked per account).
 * Always 2xx (POST default 201): `{ valid, ... }` carries the verdict instead of
 * an HTTP error,
 * so the UI can show the reason inline without exception plumbing.
 */
@Controller('promos')
@ApiTags('promos')
export class PromosController {
  constructor(private readonly service: PromosService) {}

  @Post('validate')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Preview a promo code against a cart', description: 'Public: checkout is guest-allowed (a valid bearer token additionally enforces per-user caps). Answers SUCCESS even for invalid codes — the `{ valid, ... }` body carries the verdict so the UI can show it inline (an invalid code is NOT an HTTP error). Verdict covers expiry window and usage caps too. Order creation re-evaluates server-side regardless.' })
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
  validate(@Body() dto: ValidatePromoDto, @CurrentUser() user?: any) {
    return this.service.preview(dto.code, dto.restaurantId, dto.subtotalCents, {
      userId: user?.sub ?? null,
    });
  }
}
