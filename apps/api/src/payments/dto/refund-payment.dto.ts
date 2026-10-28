import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * Admin refund input. ONE optional field: omit `amountCents` to refund the
 * full remaining captured amount; supply it for a partial refund. There is
 * deliberately no way to refund MORE than what a row captured — the ceiling
 * is checked against the row server-side (INVALID_REFUND_AMOUNT), because
 * `remaining` is live data, not a DTO-level constant. (Every DTO property
 * carries class-validator decorators; the global whitelist pipe strips
 * anything else — notably any idea of "refund against another order".)
 */
export class RefundPaymentDto {
  @ApiPropertyOptional({
    description:
      'Cents to refund. Omit for a full refund of the remaining captured amount. Must not exceed what is still refundable on THIS payment.',
    type: 'integer',
    minimum: 1,
    example: 1500,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  amountCents?: number;
}
