import {
  Body,
  Controller,
  Delete,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
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
export class MenuItemsController {
  constructor(private readonly service: MenuService) {}

  private actor(user: any) {
    return { sub: user.sub, role: user.role as UserRole };
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.service.updateItem(id, this.actor(user), dto);
  }

  /** Availability toggle. Distinct segment count from PATCH :id — no shadowing. */
  @Patch(':id/availability')
  setAvailability(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateAvailabilityDto,
  ) {
    return this.service.setAvailability(id, this.actor(user), dto.isAvailable);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.remove(id, this.actor(user));
  }
}
