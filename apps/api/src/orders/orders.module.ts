import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './order.entity';
import { OrderItem } from './order-item.entity';
import { OrderStatusAudit } from './order-status-audit.entity';
import { Payment } from '../payments/payment.entity';
import { OrdersService } from './orders.service';
import { OrderEventsService } from './order-events.service';
import { RealtimeGateway } from './realtime.gateway';
import { OrdersController } from './orders.controller';
import { RestaurantOrdersController } from './restaurant-orders.controller';
import { DriverOrdersController } from './driver-orders.controller';
import { MenuModule } from '../menu/menu.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { AuthModule } from '../auth/auth.module';
import { PromosModule } from '../promos/promos.module';
import { UsersModule } from '../users/users.module';
import { DriverOnlyGuard } from '../common/driver-only.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem, OrderStatusAudit, Payment]),
    MenuModule,
    RestaurantsModule,
    AuthModule,
    PromosModule,
    UsersModule,
  ],
  providers: [OrdersService, OrderEventsService, RealtimeGateway, DriverOnlyGuard],
  controllers: [OrdersController, RestaurantOrdersController, DriverOrdersController],
  exports: [OrdersService, OrderEventsService],
})
export class OrdersModule {}
