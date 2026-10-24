import {
  Body,
  Controller,
  Delete,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ApiError, MenuItemResponse } from '../common/swagger-response-models';
import { MenuService } from './menu.service';
import {
  UpdateAvailabilityDto,
  UpdateMenuItemDto,
} from './dto/menu-item.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { UserRole } from '../users/user.entity';

/**
 * Dish-scoped owner routes. Ownership is resolved through the dish's parent
 * restaurant inside MenuService, so one owner endpoint set works regardless
 * of which restaurant URL the owner happens to know.
 */
@Controller('menu/items')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
@ApiTags('menu')
@ApiBearerAuth()
export class MenuItemsController {
  constructor(private readonly service: MenuService) {}

  private actor(user: any) {
    return { sub: user.sub, role: user.role as UserRole };
  }

  @Patch(':id')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Owner: edit dish content', description: 'Partial update; availability lives on its own route and `restaurantId` is not editable — a dish never moves between restaurants.' })
  @ApiOkResponse({ type: MenuItemResponse })
  @ApiError(400, 'Body failed validation.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not OWNER (admins bypass).')
  @ApiError(404, 'Unknown or malformed dish id.')
  update(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.service.updateItem(id, this.actor(user), dto);
  }

  /** Availability toggle. Distinct segment count from PATCH :id — no shadowing. */
  @Patch(':id/availability')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Owner: toggle availability (sold out / back in stock)' })
  @ApiOkResponse({ type: MenuItemResponse })
  @ApiError(400, 'Body failed validation (isAvailable must be boolean).')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not OWNER (admins bypass).')
  @ApiError(404, 'Unknown or malformed dish id.')
  setAvailability(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateAvailabilityDto,
  ) {
    return this.service.setAvailability(id, this.actor(user), dto.isAvailable);
  }

  @Delete(':id')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Owner: delete a dish', description: 'Ownership is resolved through the dish\u2019s parent restaurant; foreign/unknown ids answer 404.' })
  @ApiOkResponse({ type: MenuItemResponse, description: 'Pre-delete snapshot of the dish (order history keeps its own name/price snapshots).' })
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not OWNER (admins bypass).')
  @ApiError(404, 'Unknown or malformed dish id.')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.remove(id, this.actor(user));
  }
}
