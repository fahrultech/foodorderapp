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
 *
 * Test/CI rig:
 *   SMTP_JSON_CAPTURE – "true"/"1"/"yes" swaps in nodemailer's jsonTransport:
 *     NOTHING is delivered, and every message is instead logged as one
 *     single-line `MAIL_CAPTURED {"to":...,"subject":...,"text":...}` entry. Live
 *     smokes can then prove the full notification chain without a mail relay
 *     (and without SMTP_HOST). Takes precedence over SMTP_HOST when both are
 *     set; a dev-box mistake can only silence delivery, never leak secrets.
 */
@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;
  private jsonCapture = false;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('SMTP_HOST');
    this.from = this.config.get<string>('SMTP_FROM') ?? 'FoodOrder <noreply@foodorder.app>';

    const capture = ['true', '1', 'yes'].includes(
      (this.config.get<string>('SMTP_JSON_CAPTURE') ?? '').toLowerCase(),
    );
    if (capture) {
      this.jsonCapture = true;
      this.transporter = nodemailer.createTransport({ jsonTransport: true });
      this.log.warn(
        'SMTP_JSON_CAPTURE is on — emails are LOGGED as MAIL_CAPTURED lines, not delivered (rig mode)',
      );
      return;
    }

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
      if (this.jsonCapture) {
        // One greppable line per message (JSON.stringify flattens the body's
        // newlines) — the live-smoke assertion target for rig mode.
        this.log.log(
          `MAIL_CAPTURED ${JSON.stringify({
            to: opts.to,
            subject: opts.subject,
            text: opts.text,
          })}`,
        );
      }
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
