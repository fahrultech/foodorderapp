import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MenuService } from './menu.service';
import { CreateMenuItemDto } from './dto/menu-item.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { UserRole } from '../users/user.entity';

@Controller('restaurants/:restaurantId/menu')
export class MenuController {
  constructor(private readonly service: MenuService) {}

  @Get()
  list(@Param('restaurantId') restaurantId: string) {
    return this.service.findByRestaurant(restaurantId);
  }

  /** Owner adds a dish to their own restaurant (admin bypasses). */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  create(
    @Param('restaurantId') restaurantId: string,
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
