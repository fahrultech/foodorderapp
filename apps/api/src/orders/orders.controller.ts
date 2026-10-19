import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListMyOrdersDto } from './dto/list-my-orders.dto';
import { OrderStatus } from './order.entity';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/optional-jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';

@Controller('orders')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}

  /**
   * Guest checkout allowed. When a valid access token is present the order is
   * attached to that user (enables /orders/my + self-cancellation); invalid or
   * expired tokens silently fall back to guest — checkout must never break on
   * a stale session.
   */
  @Post()
  @UseGuards(OptionalJwtAuthGuard)
  create(@Body() dto: CreateOrderDto, @CurrentUser() user?: any) {
    return this.service.create(dto, user?.sub);
  }

  @Get('my')
  @UseGuards(JwtAuthGuard)
  my(@CurrentUser() user: any, @Query() query: ListMyOrdersDto) {
    return this.service.findMine(user.sub, query);
  }

  /** Customer cancels their own order while the status machine still permits it. */
  @Post(':id/cancel')
  @UseGuards(JwtAuthGuard)
  cancel(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.cancel(id, user.sub);
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Get(':id/next-statuses')
  async next(@Param('id') id: string) {
    return { next: await this.service.nextStatuses(id) };
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Query('status') status: OrderStatus) {
    return this.service.updateStatus(id, status);
  }
}
