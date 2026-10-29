import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../orders/order.entity';
import { User } from '../users/user.entity';
import { OrdersModule } from '../orders/orders.module';
import { MailService } from './mail.service';
import { OrderNotificationsService } from './order-notifications.service';

/**
 * Handles all outbound email notifications.
 *
 * Imports:
 *   - OrdersModule: exposes OrderEventsService (the shared pub/sub bus)
 *     and OrdersService (so subscribers can load full order rows).
 *   - TypeOrmModule.forFeature([Order, User]): direct repo access —
 *     we need the User email which is not on the Order entity itself.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Order, User]),
    OrdersModule,
  ],
  providers: [MailService, OrderNotificationsService],
  exports: [MailService],
})
export class NotificationsModule {}
