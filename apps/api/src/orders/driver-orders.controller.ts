import { Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { UuidParam } from '../common/uuid';
import { CurrentUser } from '../common/current-user.decorator';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { DriverOnlyGuard } from '../common/driver-only.guard';
import { ApiError, OrderResponse, PaginatedOrdersResponse } from '../common/swagger-response-models';
import { ListMyOrdersDto } from './dto/list-my-orders.dto';
import { SetOrderStatusDto } from './dto/set-order-status.dto';
import { OrdersService } from './orders.service';

@Controller('driver/orders')
@ApiTags('driver')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, DriverOnlyGuard)
export class DriverOrdersController {
  constructor(private readonly service: OrdersService) {}

  @Get()
  @ApiOperation({
    summary: 'Driver: list my assigned orders',
    description: 'Exact DRIVER role required. The assignment scope comes from the JWT subject; supports the standard status/page/limit query contract.',
  })
  @ApiOkResponse({ type: PaginatedOrdersResponse })
  @ApiError(400, 'Invalid status or paging query.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not DRIVER (ADMIN does not bypass).')
  list(@CurrentUser() user: any, @Query() query: ListMyOrdersDto) {
    return this.service.findForDriver(user.sub, query);
  }

  @Patch(':id/status')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({
    summary: 'Driver: advance my assigned order',
    description: 'Only PREPARING→DELIVERING and DELIVERING→COMPLETED are allowed. Unknown and foreign assignments both answer 404.',
  })
  @ApiOkResponse({ type: OrderResponse })
  @ApiError(400, 'Malformed order id, invalid status value, or illegal driver transition.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not DRIVER (ADMIN does not bypass).')
  @ApiError(404, 'Unknown order or order assigned to another driver.')
  setStatus(
    @UuidParam('id') id: string,
    @CurrentUser() user: any,
    @Query() dto: SetOrderStatusDto,
  ) {
    return this.service.setStatusForDriver(id, dto.status, user.sub);
  }
}
