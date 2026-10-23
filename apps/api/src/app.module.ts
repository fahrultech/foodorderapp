import * as path from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RestaurantsModule } from './restaurants/restaurants.module';
import { MenuModule } from './menu/menu.module';
import { OrdersModule } from './orders/orders.module';
import { ReviewsModule } from './reviews/reviews.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url:
          config.get<string>('DATABASE_URL') ||
          'postgresql://foodorder:***@localhost:5432/foodorder',
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
    RestaurantsModule,
    MenuModule,
    OrdersModule,
    ReviewsModule,
  ],
})
export class AppModule {}
