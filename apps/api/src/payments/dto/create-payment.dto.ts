import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

/**
 * The whole client input surface for starting a payment: ONE order id.
 * No amount, no currency, no provider — the server snapshots order.totalCents
 * and the deployed config picks the gateway. (Every DTO property carries a
 * class-validator decorator; the global whitelist pipe strips anything else.)
 */
export class CreatePaymentDto {
  @ApiProperty({
    description: 'Order to pay. Must be yours (or a guest order), still pending/confirmed, and not already paid.',
    type: 'string',
    format: 'uuid',
  })
  @IsString()
  @IsNotEmpty()
  @IsUUID()
  orderId: string;
}
