import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './order.entity';
import { OrderItem } from './order-item.entity';
import { Payment } from '../payments/payment.entity';
import { OrdersService } from './orders.service';
import { OrderEventsService } from './order-events.service';
import { RealtimeGateway } from './realtime.gateway';
import { OrdersController } from './orders.controller';
import { RestaurantOrdersController } from './restaurant-orders.controller';
import { MenuModule } from '../menu/menu.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { AuthModule } from '../auth/auth.module';
import { PromosModule } from '../promos/promos.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem, Payment]),
    MenuModule,
    RestaurantsModule,
    AuthModule,
    PromosModule,
    UsersModule,
  ],
  providers: [OrdersService, OrderEventsService, RealtimeGateway],
  controllers: [OrdersController, RestaurantOrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
