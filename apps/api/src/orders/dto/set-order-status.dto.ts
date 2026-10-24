import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '../order.entity';

/**
 * Query string for the status-transition PATCH routes. `status` arrives as a
 * raw query param (matching the existing /orders/:id/status shape); the enum
 * check turns junk values into a clean 400 from the global ValidationPipe
 * instead of a generic "cannot move" from the service. Every DTO property
 * needs a validator decorator or whitelist:true strips it.
 */
export class SetOrderStatusDto {
  @ApiProperty({ enum: OrderStatus, enumName: 'OrderStatus', description: 'Target status (query param, not body). Illegal transitions answer 400.' })
  @IsEnum(OrderStatus, {
    message: 'status must be one of: pending, confirmed, preparing, delivering, completed, cancelled',
  })
  status: OrderStatus;
}
