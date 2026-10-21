import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { ListMyOrdersDto } from './dto/list-my-orders.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { UserRole } from '../users/user.entity';

/**
 * Owner portal read path: GET /api/restaurants/:id/orders — the orders inbox
 * behind the /dashboard page. Lives in OrdersModule (which already imports
 * RestaurantsModule) so there is no module cycle; the route shape follows the
 * REST resource, not the module layout. Ownership is checked in
 * OrdersService.findForRestaurant (admins bypass).
 */
@Controller('restaurants/:id/orders')
export class RestaurantOrdersController {
  constructor(private readonly service: OrdersService) {}

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  list(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Query() query: ListMyOrdersDto,
  ) {
    return this.service.findForRestaurant(id, { sub: user.sub, role: user.role }, query);
  }
}
