import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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
  PaginatedRestaurantsResponse,
  RestaurantResponse,
  RestaurantWithMenuResponse,
} from '../common/swagger-response-models';
import { RestaurantsService } from './restaurants.service';
import { CreateRestaurantDto, UpdateRestaurantDto } from './dto/restaurant.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { UserRole } from '../users/user.entity';

@Controller('restaurants')
@ApiTags('restaurants')
export class RestaurantsController {
  constructor(private readonly service: RestaurantsService) {}

  @Get()
  @ApiQuery({ name: 'search', required: false, description: 'Case-insensitive substring over name and cuisine' })
  @ApiQuery({ name: 'cuisine', required: false, description: 'Exact match, case-insensitive' })
  @ApiQuery({ name: 'city', required: false, description: 'Exact match, case-insensitive' })
  @ApiQuery({ name: 'sort', required: false, enum: ['rating', 'deliveryFee', 'newest'], description: 'Default: rating (highest first)' })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } })
  @ApiOperation({ summary: 'Browse restaurants (public storefront search)', description: 'Returns `{ items, total, page, limit }`. `search` is a case-insensitive substring over name and cuisine.' })
  @ApiOkResponse({ type: PaginatedRestaurantsResponse })
  list(
    @Query('search') search?: string,
    @Query('cuisine') cuisine?: string,
    @Query('city') city?: string,
    @Query('sort') sort?: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.service.findAll({ search, cuisine, city, sort, page, limit });
  }

  @Get('meta/cuisines')
  @ApiOperation({ summary: 'Distinct cuisine list for the storefront filter chips', description: 'Declared before /:id on purpose — do not reorder.' })
  @ApiOkResponse({ type: String, isArray: true, description: 'Sorted distinct non-empty cuisine names.' })
  async cuisines() {
    const all = await this.service.findRestaurants();
    return [...new Set(all.map((r) => r.cuisine).filter(Boolean))].sort();
  }

  /** Owner's own restaurants (declared before :id so it isn't captured). */
  @Get('mine')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Owner: list the restaurants I own' })
  @ApiOkResponse({ type: [RestaurantResponse] })
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not OWNER.')
  mine(@CurrentUser() user: any) {
    return this.service.findOwned(user.sub);
  }

  /** Owner self-service onboarding: create a restaurant owned by the caller. */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Owner: create a restaurant', description: 'The new restaurant is owned by the caller. `slug` auto-derives from the name when omitted; a taken slug gets an `-N` suffix instead of failing.' })
  @ApiCreatedResponse({ type: RestaurantResponse })
  @ApiError(400, 'Body failed validation.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not OWNER.')
  create(@CurrentUser() user: any, @Body() dto: CreateRestaurantDto) {
    return this.service.createForOwner(user.sub, dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Owner: edit own restaurant', description: '`ownerId`, `slug` and `rating` are intentionally not editable here.' })
  @ApiOkResponse({ type: RestaurantResponse })
  @ApiError(400, 'Body failed validation.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Restaurant belongs to another owner (admins bypass).')
  @ApiError(404, 'Unknown or malformed restaurant id.')
  update(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateRestaurantDto,
  ) {
    return this.service.updateOwned(id, { sub: user.sub, role: user.role }, dto);
  }

  @Get(':id')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'One restaurant incl. its menu items', description: 'Public. Unknown or non-UUID ids answer 404.' })
  @ApiOkResponse({ type: RestaurantWithMenuResponse })
  @ApiError(404, 'Unknown or malformed restaurant id.')
  async one(@Param('id') id: string) {
    const restaurant = await this.service.findOne(id);
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    return restaurant;
  }
}
