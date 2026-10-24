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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
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
@ApiTags('reviews')
@ApiBearerAuth()
export class ReviewsController {
  constructor(private readonly service: ReviewsService) {}

  /** Review one of the caller's COMPLETED orders. Duplicate -> 409. */
  @Post()
  @ApiOperation({ summary: 'Review a completed order of mine', description: 'The order must belong to the caller AND be completed (otherwise 404/400); one review per order — duplicates answer 409. Restaurant rating is recomputed server-side.' })
  create(@CurrentUser() user: any, @Body() dto: CreateReviewDto) {
    return this.service.create(user.sub, dto);
  }

  /** Every review the caller wrote, newest first. */
  @Get('my')
  @ApiOperation({ summary: 'My reviews, newest first' })
  mine(@CurrentUser() user: any) {
    return this.service.listMine(user.sub);
  }

  /** Edit own review (rating and/or comment; `comment: null` clears text). */
  @Patch(':id')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Edit my review', description: 'At least one of rating/comment required; `comment: null` clears the text. Foreign/unknown ids answer 404.' })
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateReviewDto,
  ) {
    return this.service.update(user.sub, id, dto);
  }

  /** Delete own review. Idempotent: unknown/foreign ids answer `removed:false`. */
  @Delete(':id')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Delete my review (idempotent)', description: 'Retried deletes of unknown/foreign ids answer `{ removed: false }`, never 404. Rating recomputed when a review disappears.' })
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
@ApiTags('reviews')
export class RestaurantReviewsController {
  constructor(private readonly service: ReviewsService) {}

  @Get()
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiOperation({ summary: 'Public review feed of one restaurant (paginated)', description: 'No auth: restaurant pages are public; each row exposes only the reviewer\u2019s display name. Unknown/non-UUID restaurant → 404.' })
  list(
    @Param('id') id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.service.listForRestaurant(id, page, limit);
  }
}
