import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../orders/order.entity';
import { User } from '../users/user.entity';
import { OrdersModule } from '../orders/orders.module';
import { MailService } from './mail.service';
import { OrderNotificationsService } from './order-notifications.service';
import { PushSubscription } from './push-subscription.entity';
import { PushService } from './push.service';
import { NotificationsController } from './notifications.controller';
import { AuthModule } from '../auth/auth.module';

/**
 * Handles outbound email and browser-push notifications.
 *
 * Imports:
 *   - OrdersModule: exposes OrderEventsService (the shared pub/sub bus)
 *     and OrdersService (so subscribers can load full order rows).
 *   - TypeOrmModule.forFeature([Order, User, PushSubscription]): direct repo
 *     access for customer email and persisted browser delivery endpoints.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Order, User, PushSubscription]),
    OrdersModule,
    AuthModule,
  ],
  controllers: [NotificationsController],
  providers: [MailService, PushService, OrderNotificationsService],
  exports: [MailService, PushService],
})
export class NotificationsModule {}
