import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from '../orders/order.entity';
import { User } from '../users/user.entity';
import { normalizeContactEmail } from '../orders/orders.service';
import { OrderEventsService, OrderEvent } from '../orders/order-events.service';
import { issueReceiptAccessToken, receiptTokenTtlSec } from '../orders/receipt-access';
import { ConfigService } from '@nestjs/config';
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
    // Magic-link issuance (Phase 14 #5). Optional so every pre-feature
    // harness construction (positional or DI without the provider) keeps
    // working — the link line then simply renders absent (byte-identical
    // legacy copy). The app always injects it via the global ConfigModule.
    @Optional()
    private readonly config?: ConfigService,
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
   * Resolve the recipient address + channel flags for an order
   * (Phase 14 per-user channel settings ride this single read):
   * - authenticated orders keep the BEARER-ONLY rule: user.email, and ONLY
   *   user.email. The stored `contactEmail` is never used as a fallback —
   *   for signed-in customers it is checkout input, not a verified address,
   *   and a vanished user row (GDPR erasure also NULLs contactEmail) means
   *   no email, exactly as before this feature. The per-user toggles gate
   *   each channel: `orderEmailEnabled === false` suppresses the email,
   *   `orderPushEnabled === false` suppresses the push fan-out. STRICT
   *   false checks: an unwritten column (legacy/imported rows, fixtures)
   *   reads as ON, so defaults preserve the pre-feature behavior.
   * - guest orders use `orders.contactEmail` (the session-76 receipt-proof
   *   column, session-45's deferred follow-up), untouched by the toggles —
   *   there is no account to consult, and the proof address is the receipt
   *   contract. Service-layer writes store it normalized; re-normalize
   *   defensively so legacy/imported rows can never email a non-canonical
   *   address.
   */
  private async resolveChannels(
    order: Order,
  ): Promise<{ email: string | null; pushEnabled: boolean }> {
    if (order.userId) {
      const user = await this.users.findOne({
        where: { id: order.userId },
        select: ['email', 'name', 'orderEmailEnabled', 'orderPushEnabled'],
      });
      return {
        email:
          user && user.orderEmailEnabled !== false ? user.email ?? null : null,
        pushEnabled: user?.orderPushEnabled !== false,
      };
    }
    return { email: normalizeContactEmail(order.contactEmail), pushEnabled: false };
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

  /**
   * Magic-link receipt URL (Phase 14 #5): the short-lived signed
   * capability token (receipt-access.ts) riding the storefront's order
   * page. FAIL-OPEN by design: no visible secret (bare unit harnesses) or
   * a throwing mint collapses to null — the template then renders NO link
   * line (legacy byte-identical copy) and a notification can never die on
   * its own link builder.
   */
  private receiptUrl(order: Order): string | null {
    try {
      const secret = this.config?.get<string>('JWT_SECRET');
      if (!secret) return null;
      const token = issueReceiptAccessToken(
        order.id,
        secret,
        receiptTokenTtlSec(this.config?.get<string>('RECEIPT_TOKEN_TTL_SEC')),
      );
      return `${this.webBaseUrl()}/orders/${order.id}?rt=${token}`;
    } catch {
      return null;
    }
  }

  /** `WEB_PUBLIC_URL` env, trailing slashes trimmed; dev default :3000. */
  private webBaseUrl(): string {
    const raw = this.config?.get<string>('WEB_PUBLIC_URL');
    const v = (raw ?? '').trim().replace(/\/+$/, '');
    return v || 'http://localhost:3000';
  }

  private async sendOrderConfirmation(orderId: string): Promise<void> {
    const order = await this.orders.findOne({
      where: { id: orderId },
      relations: { restaurant: true, items: true },
    });
    if (!order) return;
    const { email: to, pushEnabled } = await this.resolveChannels(order);

    const { subject, text } = confirmationEmail(
      { ...order, receiptUrl: this.receiptUrl(order) },
      this.localesFor(order),
    );

    await Promise.all([
      to ? this.mail.send({ to, subject, text }, 'confirmation') : Promise.resolve(),
      order.userId && pushEnabled
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
    const { email: to, pushEnabled } = await this.resolveChannels(order);

    const message = statusUpdateEmail(
      { ...order, receiptUrl: this.receiptUrl(order) },
      status,
      this.localesFor(order),
    );
    if (!message) return;

    // Push stays bearer-only and English (the label table is EN-keyed; see
    // the locales note in email-copy.ts).
    const enLabel = STATUS_UPDATE_LABELS.en[status] as string;

    await Promise.all([
      to
        ? this.mail.send({ to, subject: message.subject, text: message.text }, 'status')
        : Promise.resolve(),
      order.userId && pushEnabled
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
