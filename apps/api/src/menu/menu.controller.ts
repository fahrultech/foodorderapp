import { Controller, Get, Param } from '@nestjs/common';
import { MenuService } from './menu.service';

@Controller('restaurants/:restaurantId/menu')
export class MenuController {
  constructor(private readonly service: MenuService) {}

  @Get()
  list(@Param('restaurantId') restaurantId: string) {
    return this.service.findByRestaurant(restaurantId);
  }
}
