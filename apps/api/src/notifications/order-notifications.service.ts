import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from '../orders/order.entity';
import { User } from '../users/user.entity';
import { normalizeContactEmail } from '../orders/orders.service';
import { OrderEventsService, OrderEvent } from '../orders/order-events.service';
import { MailService } from './mail.service';
import { PushService } from './push.service';
import {
  EmailLocale,
  confirmationEmail,
  hasStatusNotice,
  statusUpdateEmail,
  STATUS_UPDATE_LABELS,
} from './email-copy';

@Injectable()
export class OrderNotificationsService implements OnModuleInit {
  private readonly log = new Logger(OrderNotificationsService.name);

  constructor(
    private readonly events: OrderEventsService,
    private readonly mail: MailService,
    private readonly push: PushService,
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

  /**
   * Resolve the recipient address for an order:
   * - authenticated orders keep the BEARER-ONLY rule: user.email, and ONLY
   *   user.email. The stored `contactEmail` is never used as a fallback —
   *   for signed-in customers it is checkout input, not a verified address,
   *   and a vanished user row (GDPR erasure also NULLs contactEmail) means
   *   no email, exactly as before this feature.
   * - guest orders use `orders.contactEmail` (the session-76 receipt-proof
   *   column, session-45's deferred follow-up). Service-layer writes store
   *   it normalized; re-normalize defensively so legacy/imported rows can
   *   never email a non-canonical address.
   */
  private async resolveEmail(order: Order): Promise<string | null> {
    if (order.userId) {
      const user = await this.users.findOne({ where: { id: order.userId }, select: ['email', 'name'] });
      return user?.email ?? null;
    }
    return normalizeContactEmail(order.contactEmail);
  }

  /**
   * Copy locales per recipient (see email-copy.ts header): authenticated
   * recipients get the long-standing English templates untouched; guests
   * have no stored locale signal anywhere server-side, so they receive one
   * bilingual EN+ID email.
   */
  private localesFor(order: Order): EmailLocale[] {
    return order.userId ? ['en'] : ['en', 'id'];
  }

  private async sendOrderConfirmation(orderId: string): Promise<void> {
    const order = await this.orders.findOne({
      where: { id: orderId },
      relations: { restaurant: true, items: true },
    });
    if (!order) return;
    const to = await this.resolveEmail(order);

    const { subject, text } = confirmationEmail(order, this.localesFor(order));

    await Promise.all([
      to ? this.mail.send({ to, subject, text }) : Promise.resolve(),
      order.userId
        ? this.push.sendToUser(order.userId, {
            title: `Order received — #${order.code}`,
            body: `${order.restaurant.name} received your order.`,
            url: `/orders/${order.id}`,
            tag: `order-${order.id}`,
          })
        : Promise.resolve(),
    ]);
    if (to) this.log.log(`Order-confirm email sent to ${to} for #${order.code}`);
  }

  private async sendStatusUpdate(orderId: string, status: OrderStatus): Promise<void> {
    if (!hasStatusNotice(status)) return; // PENDING has no update email (confirmed = the creation mail)

    const order = await this.orders.findOne({
      where: { id: orderId },
      relations: { restaurant: true },
    });
    if (!order) return;
    const to = await this.resolveEmail(order);

    const message = statusUpdateEmail(order, status, this.localesFor(order));
    if (!message) return;

    // Push stays bearer-only and English (the label table is EN-keyed; see
    // the locales note in email-copy.ts).
    const enLabel = STATUS_UPDATE_LABELS.en[status] as string;

    await Promise.all([
      to ? this.mail.send({ to, subject: message.subject, text: message.text }) : Promise.resolve(),
      order.userId
        ? this.push.sendToUser(order.userId, {
            title: `${enLabel} — #${order.code}`,
            body: `${order.restaurant.name}: ${enLabel}.`,
            url: `/orders/${order.id}`,
            tag: `order-${order.id}`,
          })
        : Promise.resolve(),
    ]);
    if (to) this.log.log(`Status-update email (${status}) sent to ${to} for #${order.code}`);
  }
}
