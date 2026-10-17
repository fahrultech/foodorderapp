import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { RestaurantsService } from './restaurants.service';

@Controller('restaurants')
export class RestaurantsController {
  constructor(private readonly service: RestaurantsService) {}

  @Get()
  list(
    @Query('search') search?: string,
    @Query('cuisine') cuisine?: string,
    @Query('city') city?: string,
    @Query('sort') sort?: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.service.findAll({ search, cuisine, city, sort, page, limit });
  }

  @Get('meta/cuisines')
  async cuisines() {
    const all = await this.service.findRestaurants();
    return [...new Set(all.map((r) => r.cuisine).filter(Boolean))].sort();
  }

  @Get(':id')
  async one(@Param('id') id: string) {
    const restaurant = await this.service.findOne(id);
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    return restaurant;
  }
}
