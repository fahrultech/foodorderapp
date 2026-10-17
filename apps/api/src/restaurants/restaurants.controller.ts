import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RestaurantsService } from './restaurants.service';
import { CreateRestaurantDto, UpdateRestaurantDto } from './dto/restaurant.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { UserRole } from '../users/user.entity';

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

  /** Owner's own restaurants (declared before :id so it isn't captured). */
  @Get('mine')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  mine(@CurrentUser() user: any) {
    return this.service.findOwned(user.sub);
  }

  /** Owner self-service onboarding: create a restaurant owned by the caller. */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  create(@CurrentUser() user: any, @Body() dto: CreateRestaurantDto) {
    return this.service.createForOwner(user.sub, dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  update(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateRestaurantDto,
  ) {
    return this.service.updateOwned(id, { sub: user.sub, role: user.role }, dto);
  }

  @Get(':id')
  async one(@Param('id') id: string) {
    const restaurant = await this.service.findOne(id);
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    return restaurant;
  }
}
