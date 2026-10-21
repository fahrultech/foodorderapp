import { Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { ListMyOrdersDto } from './dto/list-my-orders.dto';
import { SetOrderStatusDto } from './dto/set-order-status.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { UserRole } from '../users/user.entity';

/**
 * Owner portal routes under /api/restaurants/:id/orders — the orders inbox
 * behind the /dashboard page plus its status actions (accept/start/deliver/
 * complete/cancel). Lives in OrdersModule (which already imports
 * RestaurantsModule) so there is no module cycle; the route shape follows the
 * REST resource, not the module layout. Ownership is enforced in
 * OrdersService (admins bypass): the restaurant must belong to the caller and
 * the order must belong to the restaurant in the path.
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

  /**
   * Owner status action. `status` is a query param like the generic
   * /orders/:id/status route, validated against the OrderStatus enum by DTO.
   * Same OWNER role gate as the inbox: customer tokens get 403 from
   * RolesGuard, admin tokens pass it and rely on the service-side ownership
   * bypass (admins may action any restaurant's orders).
   */
  @Patch(':orderId/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  setStatus(
    @Param('id') id: string,
    @Param('orderId') orderId: string,
    @CurrentUser() user: any,
    @Query() dto: SetOrderStatusDto,
  ) {
    return this.service.setStatusForRestaurant(
      id,
      orderId,
      dto.status,
      { sub: user.sub, role: user.role },
    );
  }
}

