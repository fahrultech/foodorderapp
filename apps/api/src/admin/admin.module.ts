import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { Order } from '../orders/order.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { User } from '../users/user.entity';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, Restaurant, Order]), AuthModule, MetricsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
