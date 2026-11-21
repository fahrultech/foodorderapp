import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Restaurant } from './restaurant.entity';
import { RestaurantHours } from './restaurant-hours.entity';
import { Order } from '../orders/order.entity';
import { RestaurantsService } from './restaurants.service';
import { RestaurantsController } from './restaurants.controller';
import { AuthModule } from '../auth/auth.module';
import { City } from '../cities/city.entity';
import { MenuModule } from '../menu/menu.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { RestaurantMetricsController } from './restaurant-metrics.controller';

@Module({
  // AuthModule exports JwtModule — required for JwtAuthGuard on owner routes.
  // MenuModule: MenuService embeds option groups on findOne's menuItems
  // (storefront picker, session 66). No cycle: MenuModule imports only Auth.
  // MetricsModule (session 98): the process-lifetime registry behind the
  // owner-scoped /restaurants/:id/metrics read. No cycle: MetricsModule
  // imports only its own snapshot table.
  // Order (session 113): RAW read-only aggregate for the delivery ETA on
  // GET /restaurants/:id — the entity is registered here for the repository
  // token ONLY; there is no OrdersModule import and no DI cycle.
  imports: [TypeOrmModule.forFeature([Restaurant, RestaurantHours, City, Order]), AuthModule, MenuModule, MetricsModule],
  providers: [RestaurantsService],
  controllers: [RestaurantsController, RestaurantMetricsController],
  exports: [RestaurantsService],
})
export class RestaurantsModule {}
