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
   * Magic-link capability token (Phase 14 #5; Phase 16 #4 rides it on
   * PUSH too): the short-lived signed token (receipt-access.ts) that
   * unlocks exactly this order on the storefront receipt read. FAIL-OPEN
   * by design: no visible secret (bare unit harnesses) or a throwing mint
   * collapses to null — the email template then renders NO link line
   * (legacy byte-identical copy), the push keeps the bare relative url,
   * and a notification can never die on its own link builder.
   * MINTED ONCE PER EVENT so the email line and the push payload carry
   * the SAME capability (one token per notification, both channels).
   */
  private receiptTokenFor(order: Order): string | null {
    try {
      const secret = this.config?.get<string>('JWT_SECRET');
      if (!secret) return null;
      return issueReceiptAccessToken(
        order.id,
        secret,
        receiptTokenTtlSec(this.config?.get<string>('RECEIPT_TOKEN_TTL_SEC')),
      );
    } catch {
      return null;
    }
  }

  /** Full storefront URL carrying the pre-minted token; null when absent. */
  private receiptUrl(order: Order, token: string | null): string | null {
    return token ? `${this.webBaseUrl()}/orders/${order.id}?rt=${token}` : null;
  }

  /**
   * Same-site push payload url (Phase 16 #4): bare `/orders/:id` plus the
   * event's capability when one was minted. Recipients are bearer-only
   * (subscriptions are JWT-scoped), but the app switch can drop the web
   * session — the rt rung then restores the read with the SAME ladder the
   * email link rides. The token is order-bound and time-bounded, so the
   * payload stays privacy-minimal (session 136 money ladder unchanged:
   * rt never pays an OWNED order — canonical 404).
   */
  private pushUrl(order: Order, token: string | null): string {
    return token ? `/orders/${order.id}?rt=${token}` : `/orders/${order.id}`;
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
    const rt = this.receiptTokenFor(order);

    const { subject, text } = confirmationEmail(
      { ...order, receiptUrl: this.receiptUrl(order, rt) },
      this.localesFor(order),
    );

    await Promise.all([
      to ? this.mail.send({ to, subject, text }, 'confirmation') : Promise.resolve(),
      order.userId && pushEnabled
        ? this.push.sendToUser(order.userId, {
            title: `Order received — #${order.code}`,
            body: `${order.restaurant.name} received your order.`,
            url: this.pushUrl(order, rt),
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
      // Session 146 (Phase 17 eager audit): status notices render the
      // LIGHT view (code/customerName/restaurant.name — StatusEmailView has
      // no items field), so the eager items join is pure waste here. The
      // explicit restaurant relation still loads with the opt-out.
      loadEagerRelations: false,
    });
    if (!order) return;
    const { email: to, pushEnabled } = await this.resolveChannels(order);
    const rt = this.receiptTokenFor(order);

    const message = statusUpdateEmail(
      { ...order, receiptUrl: this.receiptUrl(order, rt) },
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
            url: this.pushUrl(order, rt),
            tag: `order-${order.id}`,
          })
        : Promise.resolve(),
    ]);
    if (to) this.log.log(`Status-update email (${status}) sent to ${to} for #${order.code}`);
  }
}
