import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Restaurant } from './restaurant.entity';
import { RestaurantsService } from './restaurants.service';
import { RestaurantsController } from './restaurants.controller';
import { AuthModule } from '../auth/auth.module';
import { City } from '../cities/city.entity';

@Module({
  // AuthModule exports JwtModule — required for JwtAuthGuard on owner routes.
  imports: [TypeOrmModule.forFeature([Restaurant, City]), AuthModule],
  providers: [RestaurantsService],
  controllers: [RestaurantsController],
  exports: [RestaurantsService],
})
export class RestaurantsModule {}
