import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Review } from './review.entity';
import { Order } from '../orders/order.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { ReviewsController, RestaurantReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { AuthModule } from '../auth/auth.module';

/**
 * Customer reviews + server-side restaurant rating recompute (Phase 3).
 * Order/Restaurant entities are registered here for the repos the service
 * needs (order gating, rating updates) — the same repo-only pattern
 * UsersModule uses for MenuItem, so there is no module cycle.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Review, Order, Restaurant]), AuthModule],
  controllers: [ReviewsController, RestaurantReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
