import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Restaurant } from './restaurant.entity';
import { RestaurantHours } from './restaurant-hours.entity';
import { RestaurantsService } from './restaurants.service';
import { RestaurantsController } from './restaurants.controller';
import { AuthModule } from '../auth/auth.module';
import { City } from '../cities/city.entity';
import { MenuModule } from '../menu/menu.module';

@Module({
  // AuthModule exports JwtModule — required for JwtAuthGuard on owner routes.
  // MenuModule: MenuService embeds option groups on findOne's menuItems
  // (storefront picker, session 66). No cycle: MenuModule imports only Auth.
  imports: [TypeOrmModule.forFeature([Restaurant, RestaurantHours, City]), AuthModule, MenuModule],
  providers: [RestaurantsService],
  controllers: [RestaurantsController],
  exports: [RestaurantsService],
})
export class RestaurantsModule {}
