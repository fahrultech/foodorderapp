import * as path from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateEnv } from './config/env.validation';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RestaurantsModule } from './restaurants/restaurants.module';
import { MenuModule } from './menu/menu.module';
import { OrdersModule } from './orders/orders.module';
import { ReviewsModule } from './reviews/reviews.module';
import { PromosModule } from './promos/promos.module';
import { PaymentsModule } from './payments/payments.module';
import { HealthModule } from './health/health.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { NotificationsModule } from './notifications/notifications.module';
import { CitiesModule } from './cities/cities.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url:
          config.get<string>('DATABASE_URL') ||
          'postgresql://foodorder:foodorder@localhost:5432/foodorder',
        autoLoadEntities: true,
        // Schema is owned by migrations (see src/database/data-source.ts);
        // pending migrations are applied automatically on boot.
        migrations: [path.join(__dirname, 'database', 'migrations', '*.{ts,js}')],
        migrationsRun: true,
        synchronize: false,
      }),
    }),
    HealthModule,
    AuthModule,
    UsersModule,
    CitiesModule,
    RestaurantsModule,
    MenuModule,
    OrdersModule,
    ReviewsModule,
    PromosModule,
    PaymentsModule,
    RateLimitModule,
    NotificationsModule,
  ],
})
export class AppModule {}
