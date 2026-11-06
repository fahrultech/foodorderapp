import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  AdminPromoListResponse,
  AdminPromoResponse,
  ApiError,
  PromoUsageListResponse,
} from '../common/swagger-response-models';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { UuidParam } from '../common/uuid';
import { UserRole } from '../users/user.entity';
import {
  CreatePromoDto,
  ListPromoUsagesDto,
  UpdatePromoDto,
} from './dto/admin-promo.dto';
import { PromosService } from './promos.service';

/**
 * ADMIN promo-code management (Phase 5 "Coupons expiry + usage caps").
 * Codes were platform/seed-managed until here: this is the API that sets the
 * redemption window (`startsAt`/`expiresAt`), the caps (`maxTotalUsages` /
 * `maxPerUser`) and reads the append-only redemption ledger. No owner access
 * — a restaurant owner must not mint or widen their own discounts.
 */
@Controller('admin/promos')
@ApiTags('promos')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiBearerAuth()
export class PromosAdminController {
  constructor(private readonly service: PromosService) {}

  @Get()
  @ApiOperation({
    summary: 'List promo codes with live redemption counts (ADMIN)',
    description:
      'Every code plus `usageCount` (rows in the redemption ledger), newest first. ADMIN only.',
  })
  @ApiOkResponse({ type: AdminPromoListResponse })
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not ADMIN.')
  list() {
    return this.service.listAdmin();
  }

  @Post()
  @ApiOperation({
    summary: 'Create a promo code (ADMIN)',
    description:
      'Codes are normalized uppercase; percent valueCents must be 1..100 (fixed: integer cents off). Optional redemption window (startsAt inclusive / expiresAt exclusive, ISO8601) and caps (maxTotalUsages across everyone, maxPerUser per signed-in account — guests only consume the total cap). 409 on an existing code (after normalization), 400 on a bad window/value/restaurant.',
  })
  @ApiCreatedResponse({ type: AdminPromoResponse })
  @ApiError(400, 'Body failed validation (pattern, percent bounds, window order, unknown restaurant).')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not ADMIN.')
  @ApiError(409, 'The normalized code already exists.')
  create(@Body() dto: CreatePromoDto) {
    return this.service.createCode(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a promo code (ADMIN)',
    description:
      'PATCH semantics: omitted fields keep their value, explicit null CLEARS expiry or caps (`{"expiresAt": null, "maxTotalUsages": null}`). Lowering a cap below the current usageCount is allowed — the code becomes immediately spent for new redemptions; ledger rows are never touched or rewritten.',
  })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ type: AdminPromoResponse })
  @ApiError(400, 'Malformed id or body (percent bounds, startsAt >= expiresAt, unknown restaurant).')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not ADMIN.')
  @ApiError(404, 'Unknown promo code id.')
  @ApiError(409, 'Renaming collides with an existing code.')
  update(@UuidParam('id') id: string, @Body() dto: UpdatePromoDto) {
    return this.service.updateCode(id, dto);
  }

  @Get(':id/usages')
  @ApiOperation({
    summary: 'Redemption ledger for one code (ADMIN)',
    description:
      'Append-only `promo_usages` rows, newest first: who (userId null = guest), which order, and the exact cents discounted. This ledger is what the caps are counted against. Paginated `{ items, total, page, limit }`.',
  })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ type: PromoUsageListResponse })
  @ApiError(400, 'Malformed (non-UUID) id or invalid page/limit.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not ADMIN.')
  @ApiError(404, 'Unknown promo code id.')
  usages(@UuidParam('id') id: string, @Query() query: ListPromoUsagesDto) {
    return this.service.listUsages(id, query);
  }
}
