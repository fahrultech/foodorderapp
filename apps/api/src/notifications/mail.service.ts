import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import { RequestMetricsService } from '../common/metrics/request-metrics.service';
import type { MailChannel } from '../common/metrics/request-metrics';

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
 *     "fail" (session 134) is the FAILING-TRANSPORT arm of the same rig:
 *     every sendMail rejects through a stub transport (exactly what a dead
 *     relay does), each rejection lands as one `MAIL_FAILED {...}` line, and
 *     the metrics registry tallies every attempt as a FAILURE — this is what
 *     live smokes drive the email_delivery_failure alert rule with.
 *
 * Delivery telemetry (session 134): every REAL attempt (transport exists)
 * is folded into the metrics registry via `recordMail(channel, ok)` before
 * the caller sees the promise settle — a disabled channel counts NOTHING
 * (unconfigured SMTP must never look like a failing one). The
 * RequestMetricsService injection is @Optional so bare unit harnesses keep
 * constructing MailService(config) unchanged; the app always provides it
 * (NotificationsModule imports MetricsModule).
 */
@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;
  private jsonCapture = false;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: RequestMetricsService,
  ) {
    const host = this.config.get<string>('SMTP_HOST');
    this.from = this.config.get<string>('SMTP_FROM') ?? 'FoodOrder <noreply@foodorder.app>';

    const capture = (this.config.get<string>('SMTP_JSON_CAPTURE') ?? '').toLowerCase();
    if (capture === 'fail') {
      // Failing-transport rig arm (session 134): sendMail rejects like a
      // dead relay — the honest path through this class is the catch arm.
      this.transporter = {
        sendMail: async (): Promise<never> => {
          throw new Error('SMTP_JSON_CAPTURE=fail — simulated relay failure (rig mode)');
        },
      } as unknown as Transporter;
      this.log.warn(
        'SMTP_JSON_CAPTURE=fail — every mail send FAILS by design (failing-transport rig arm)',
      );
      return;
    }
    if (['true', '1', 'yes'].includes(capture)) {
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
  async send(opts: Mail.Options, channel: MailChannel = 'general'): Promise<void> {
    if (!this.transporter) return;
    // A transport exists, so this IS a real attempt (session 134): the
    // tally lands BEFORE the outcome branch so every code path — success,
    // rejection, even a logging slip — leaves the attempt counted exactly
    // once. Disabled channels returned above and count NOTHING.
    try {
      await this.transporter.sendMail({ from: this.from, ...opts });
      this.metrics?.recordMail(channel, true);
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
      this.metrics?.recordMail(channel, false);
      const message = err instanceof Error ? err.message : String(err);
      // MAIL_FAILED marker (session 134): the structured twin of MAIL_CAPTURED
      // — one greppable line per FAILED send for rig arms AND operators
      // tailing the log ("dead relay" is now a countable signal, not prose).
      this.log.error(
        `MAIL_FAILED ${JSON.stringify({
          to: String(opts.to),
          subject: String(opts.subject),
          channel,
          error: message,
        })}`,
      );
    }
  }

  /** True when SMTP is configured (useful in tests). */
  get enabled(): boolean {
    return this.transporter !== null;
  }
}
