import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RestaurantsModule } from './restaurants/restaurants.module';
import { MenuModule } from './menu/menu.module';
import { OrdersModule } from './orders/orders.module';
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
        synchronize: true,
      }),
    }),
    HealthModule,
    AuthModule,
    UsersModule,
    RestaurantsModule,
    MenuModule,
    OrdersModule,
  ],
})
export class AppModule {}
