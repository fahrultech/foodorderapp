import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UuidParam } from '../common/uuid';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ApiError, MenuItemResponse } from '../common/swagger-response-models';
import { MenuService } from './menu.service';
import { CreateMenuItemDto } from './dto/menu-item.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { UserRole } from '../users/user.entity';

@Controller('restaurants/:restaurantId/menu')
@ApiTags('menu')
export class MenuController {
  constructor(private readonly service: MenuService) {}

  @Get()
  @ApiParam({ name: 'restaurantId', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Public menu of one restaurant (categories grouped client-side)', description: 'Unknown-but-valid restaurant ids answer an empty list; a malformed (non-UUID) id answers 400.' })
  @ApiOkResponse({ type: [MenuItemResponse], description: 'Ordered by category then name.' })
  @ApiError(400, 'Malformed (non-UUID) restaurant id.')
  list(@UuidParam('restaurantId') restaurantId: string) {
    return this.service.findByRestaurant(restaurantId);
  }

  /** Owner adds a dish to their own restaurant (admin bypasses). */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  @ApiBearerAuth()
  @ApiParam({ name: 'restaurantId', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Owner: add a dish', description: 'OWNER role required (admins bypass); the restaurant in the path must belong to the caller, otherwise 404/403. `restaurantId` is taken from the URL, never the body.' })
  @ApiCreatedResponse({ type: MenuItemResponse })
  @ApiError(400, 'Body failed validation or the path id is not a UUID.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not OWNER (admins bypass).')
  @ApiError(404, 'Unknown restaurant id.')
  create(
    @UuidParam('restaurantId') restaurantId: string,
    @CurrentUser() user: any,
    @Body() dto: CreateMenuItemDto,
  ) {
    return this.service.createForRestaurant(
      restaurantId,
      { sub: user.sub, role: user.role },
      dto,
    );
  }
}
