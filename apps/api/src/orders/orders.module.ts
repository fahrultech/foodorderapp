import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './order.entity';
import { OrderItem } from './order-item.entity';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { RestaurantOrdersController } from './restaurant-orders.controller';
import { MenuModule } from '../menu/menu.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem]),
    MenuModule,
    RestaurantsModule,
    AuthModule,
  ],
  providers: [OrdersService],
  controllers: [OrdersController, RestaurantOrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
