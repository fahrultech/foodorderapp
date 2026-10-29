import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from '../orders/order.entity';
import { User } from '../users/user.entity';
import { OrderEventsService, OrderEvent } from '../orders/order-events.service';
import { MailService } from './mail.service';

/** Human-friendly labels for customer-facing status update emails. */
const STATUS_LABEL: Partial<Record<OrderStatus, string>> = {
  [OrderStatus.CONFIRMED]: 'Your order has been confirmed',
  [OrderStatus.PREPARING]: 'Your order is being prepared',
  [OrderStatus.DELIVERING]: 'Your order is on its way',
  [OrderStatus.COMPLETED]: 'Your order has been delivered',
  [OrderStatus.CANCELLED]: 'Your order has been cancelled',
};

@Injectable()
export class OrderNotificationsService implements OnModuleInit {
  private readonly log = new Logger(OrderNotificationsService.name);

  constructor(
    private readonly events: OrderEventsService,
    private readonly mail: MailService,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  onModuleInit(): void {
    this.events.stream().subscribe((event) => {
      // Fire-and-forget — errors caught inside each method.
      void this.handleEvent(event);
    });
  }

  private async handleEvent(event: OrderEvent): Promise<void> {
    try {
      if (event.type === 'order.created') {
        await this.sendOrderConfirmation(event.payload.orderId);
      } else if (event.type === 'order.updated') {
        await this.sendStatusUpdate(
          event.payload.orderId,
          event.payload.status as OrderStatus,
        );
      }
    } catch (err: unknown) {
      this.log.error(
        `Notification error for ${event.type} orderId=${event.payload.orderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Resolves the customer email for an order: user.email for authed, null for guest. */
  private async resolveEmail(order: Order): Promise<string | null> {
    if (!order.userId) return null;
    const user = await this.users.findOne({ where: { id: order.userId }, select: ['email', 'name'] });
    return user?.email ?? null;
  }

  private async sendOrderConfirmation(orderId: string): Promise<void> {
    const order = await this.orders.findOne({
      where: { id: orderId },
      relations: { restaurant: true, items: true },
    });
    if (!order) return;
    const to = await this.resolveEmail(order);
    if (!to) return; // guest order — no email address available

    const itemLines = order.items
      .map((i) => `  • ${i.name} × ${i.quantity}  ${formatCents(i.unitPriceCents * i.quantity)}`)
      .join('\n');

    const subject = `Order confirmed — #${order.code}`;
    const text = [
      `Hi ${order.customerName},`,
      ``,
      `Thanks for your order from ${order.restaurant.name}!`,
      ``,
      `Order: #${order.code}`,
      `Deliver to: ${order.deliveryAddress}`,
      ``,
      `Items:`,
      itemLines,
      ``,
      `Subtotal: ${formatCents(order.subtotalCents)}`,
      order.discountCents
        ? `Discount: -${formatCents(order.discountCents)}${order.promoCode ? ` (${order.promoCode})` : ''}`
        : null,
      `Delivery fee: ${formatCents(order.deliveryFeeCents)}`,
      `Total: ${formatCents(order.totalCents)}`,
      ``,
      `We will keep you posted as your order moves forward.`,
    ]
      .filter((l) => l !== null)
      .join('\n');

    await this.mail.send({ to, subject, text });
    this.log.log(`Order-confirm email sent to ${to} for #${order.code}`);
  }

  private async sendStatusUpdate(orderId: string, status: OrderStatus): Promise<void> {
    const label = STATUS_LABEL[status];
    if (!label) return; // PENDING has no update email (confirmed = the creation mail)

    const order = await this.orders.findOne({
      where: { id: orderId },
      relations: { restaurant: true },
    });
    if (!order) return;
    const to = await this.resolveEmail(order);
    if (!to) return;

    const subject = `${label} — #${order.code}`;
    const text = [
      `Hi ${order.customerName},`,
      ``,
      `${label}.`,
      ``,
      `Order: #${order.code}`,
      `Restaurant: ${order.restaurant.name}`,
      status === OrderStatus.CANCELLED
        ? `\nIf you did not request a cancellation, please contact support.`
        : '',
    ].join('\n');

    await this.mail.send({ to, subject, text });
    this.log.log(`Status-update email (${status}) sent to ${to} for #${order.code}`);
  }
}

/** Format integer cents as a human-readable amount (IDR 12,500). */
function formatCents(cents: number): string {
  return `IDR ${(cents).toLocaleString('id-ID')}`;
}
