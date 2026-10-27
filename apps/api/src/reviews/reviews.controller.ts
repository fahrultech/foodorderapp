import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UuidParam } from '../common/uuid';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiError,
  ReviewFeedResponse,
  ReviewListResponse,
  ReviewRemoveResponse,
  ReviewWriteResponse,
} from '../common/swagger-response-models';
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
  @ApiCreatedResponse({ type: ReviewWriteResponse })
  @ApiError(400, 'Order is not completed yet.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(404, 'Unknown order or one that is not yours (no existence leak).')
  @ApiError(409, 'This order has already been reviewed (unique per order, races included).')
  create(@CurrentUser() user: any, @Body() dto: CreateReviewDto) {
    return this.service.create(user.sub, dto);
  }

  /** Every review the caller wrote, newest first. */
  @Get('my')
  @ApiOperation({ summary: 'My reviews, newest first' })
  @ApiOkResponse({ type: ReviewListResponse })
  @ApiError(401, 'Missing/invalid/expired access token.')

  mine(@CurrentUser() user: any) {
    return this.service.listMine(user.sub);
  }

  /** Edit own review (rating and/or comment; `comment: null` clears text). */
  @Patch(':id')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Edit my review', description: 'At least one of rating/comment required; `comment: null` clears the text. Foreign/unknown ids answer 404.' })
  @ApiOkResponse({ type: ReviewWriteResponse })
  @ApiError(400, 'Patch carries neither rating nor comment, or the path id is not a UUID.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(404, 'Unknown or foreign review id.')
  update(
    @CurrentUser() user: any,
    @UuidParam('id') id: string,
    @Body() dto: UpdateReviewDto,
  ) {
    return this.service.update(user.sub, id, dto);
  }

  /** Delete own review. Idempotent: unknown/foreign ids answer `removed:false`. */
  @Delete(':id')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Delete my review (idempotent)', description: 'Retried deletes of unknown/foreign ids answer `{ removed: false }`, never 404. A malformed (non-UUID) id answers 400. Rating recomputed when a review disappears.' })
  @ApiOkResponse({ type: ReviewRemoveResponse })
  @ApiError(400, 'Malformed (non-UUID) review id.')
  @ApiError(401, 'Missing/invalid/expired access token.')

  remove(@CurrentUser() user: any, @UuidParam('id') id: string) {
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
  @ApiOperation({ summary: 'Public review feed of one restaurant (paginated)', description: 'No auth: restaurant pages are public; each row exposes only the reviewer\u2019s display name. Unknown restaurant → 404; malformed (non-UUID) id → 400.' })
  @ApiOkResponse({ type: ReviewFeedResponse })
  @ApiError(400, 'Malformed (non-UUID) restaurant id.')
  @ApiError(404, 'Unknown restaurant id.')
  list(
    @UuidParam('id') id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.service.listForRestaurant(id, page, limit);
  }
}
