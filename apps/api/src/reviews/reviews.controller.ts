import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { UpdateReviewDto } from './dto/update-review.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';

/**
 * Customer-authored review routes — everything here is scoped to the JWT
 * subject (author id comes from the token, never from the request), same
 * construction as the favorites routes. The public restaurant feed lives on
 * `RestaurantReviewsController` next door.
 */
@Controller('reviews')
@UseGuards(JwtAuthGuard)
export class ReviewsController {
  constructor(private readonly service: ReviewsService) {}

  /** Review one of the caller's COMPLETED orders. Duplicate -> 409. */
  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateReviewDto) {
    return this.service.create(user.sub, dto);
  }

  /** Every review the caller wrote, newest first. */
  @Get('my')
  mine(@CurrentUser() user: any) {
    return this.service.listMine(user.sub);
  }

  /** Edit own review (rating and/or comment; `comment: null` clears text). */
  @Patch(':id')
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateReviewDto,
  ) {
    return this.service.update(user.sub, id, dto);
  }

  /** Delete own review. Idempotent: unknown/foreign ids answer `removed:false`. */
  @Delete(':id')
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.service.remove(user.sub, id);
  }
}

/**
 * Public review feed for one restaurant — `GET /restaurants/:id/reviews`
 * (route shape follows the resource, controller lives in ReviewsModule — the
 * exact precedent set by RestaurantOrdersController). No guard: restaurant
 * pages are public, and reviews only expose the reviewer's display name.
 */
@Controller('restaurants/:id/reviews')
export class RestaurantReviewsController {
  constructor(private readonly service: ReviewsService) {}

  @Get()
  list(
    @Param('id') id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.service.listForRestaurant(id, page, limit);
  }
}
