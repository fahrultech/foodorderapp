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
import { OrderStatus } from './order.entity';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';

@Controller('orders')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}

  /** Guest checkout allowed; attaches user id when bearer token present is handled via /orders/my auth. */
  @Post()
  create(@Body() dto: CreateOrderDto) {
    return this.service.create(dto);
  }

  @Get('my')
  @UseGuards(JwtAuthGuard)
  my(@CurrentUser() user: any) {
    return this.service.findMine(user.sub);
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
