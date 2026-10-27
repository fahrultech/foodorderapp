import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from './payment.entity';
import { Order } from '../orders/order.entity';
import { PaymentsService } from './payments.service';
import { PaymentsController, OrderPaymentsController } from './payments.controller';
import { MockPaymentGateway } from './mock-payment-gateway';
import { PAYMENT_GATEWAY, PaymentGateway } from './payment-gateway.interface';
import { AuthModule } from '../auth/auth.module';

/**
 * Payment provider selection is a DEPLOYMENT decision: `PAYMENT_PROVIDER`
 * picks the adapter implementing `PaymentGateway`. Only 'mock' exists so far
 * (Stripe/Xendit are roadmap follow-ups) — an unknown value fails FAST at
 * boot instead of silently charging through the wrong adapter.
 */
export function selectPaymentGateway(
  provider: string | undefined,
  adapters: PaymentGateway[],
): PaymentGateway {
  const wanted = String(provider ?? '').trim().toLowerCase() || 'mock';
  const found = adapters.find((a) => a.id === wanted);
  if (!found) {
    throw new Error(
      `Unknown PAYMENT_PROVIDER "${wanted}" — implemented adapters: ${adapters
        .map((a) => a.id)
        .join(', ')}`,
    );
  }
  return found;
}

@Module({
  imports: [TypeOrmModule.forFeature([Payment, Order]), AuthModule],
  controllers: [PaymentsController, OrderPaymentsController],
  providers: [
    PaymentsService,
    MockPaymentGateway,
    {
      provide: PAYMENT_GATEWAY,
      inject: [ConfigService, MockPaymentGateway],
      useFactory: (config: ConfigService, mock: MockPaymentGateway): PaymentGateway =>
        selectPaymentGateway(config.get<string>('PAYMENT_PROVIDER'), [mock]),
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
