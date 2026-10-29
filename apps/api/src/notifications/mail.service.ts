import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';

/**
 * Thin wrapper around nodemailer. Disabled (no-op) when SMTP_HOST is absent.
 *
 * Required env vars (all are unset ⇒ disabled):
 *   SMTP_HOST   – mail relay hostname
 *   SMTP_PORT   – default 587
 *   SMTP_USER   – optional for relay-without-auth setups
 *   SMTP_PASS   – optional
 *   SMTP_FROM   – envelope From address, default "FoodOrder <noreply@foodorder.app>"
 *   SMTP_SECURE – "true" to force TLS on connect, default false (STARTTLS via port 587)
 */
@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('SMTP_HOST');
    this.from = this.config.get<string>('SMTP_FROM') ?? 'FoodOrder <noreply@foodorder.app>';

    if (!host) {
      this.log.warn('SMTP_HOST not set — email notifications disabled');
      this.transporter = null;
      return;
    }

    const port = Number(this.config.get<string>('SMTP_PORT') ?? '587');
    const secure = ['true', '1', 'yes'].includes(
      (this.config.get<string>('SMTP_SECURE') ?? '').toLowerCase(),
    );
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      ...(user ? { auth: { user, pass } } : {}),
    });

    this.log.log(`Mail transport ready → ${host}:${port} (secure=${secure})`);
  }

  /** Fire-and-forget. Errors are logged, never thrown to callers. */
  async send(opts: Mail.Options): Promise<void> {
    if (!this.transporter) return;
    try {
      await this.transporter.sendMail({ from: this.from, ...opts });
    } catch (err: unknown) {
      this.log.error(
        `Failed to send mail to ${String(opts.to)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** True when SMTP is configured (useful in tests). */
  get enabled(): boolean {
    return this.transporter !== null;
  }
}
