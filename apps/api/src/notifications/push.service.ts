import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as webpush from 'web-push';
import { PushSubscription } from './push-subscription.entity';
import { SavePushSubscriptionDto } from './push-subscription.dto';

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

@Injectable()
export class PushService {
  private readonly log = new Logger(PushService.name);
  private readonly publicKey: string | null;
  private readonly isEnabled: boolean;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(PushSubscription)
    private readonly subscriptions: Repository<PushSubscription>,
  ) {
    const subject = this.config.get<string>('VAPID_SUBJECT');
    const publicKey = this.config.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY');
    this.isEnabled = Boolean(subject && publicKey && privateKey);
    this.publicKey = this.isEnabled ? publicKey! : null;

    if (!this.isEnabled) {
      this.log.warn('VAPID configuration incomplete — web push notifications disabled');
      return;
    }

    webpush.setVapidDetails(subject!, publicKey!, privateKey!);
    this.log.log('Web push transport ready');
  }

  getConfig(): { enabled: boolean; publicKey: string | null } {
    return { enabled: this.isEnabled, publicKey: this.publicKey };
  }

  async subscribe(userId: string, dto: SavePushSubscriptionDto): Promise<{ subscribed: true }> {
    let row = await this.subscriptions.findOne({ where: { endpoint: dto.endpoint } });
    if (!row) {
      row = this.subscriptions.create({
        userId,
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
      });
    } else {
      row.userId = userId;
      row.p256dh = dto.keys.p256dh;
      row.auth = dto.keys.auth;
    }
    await this.subscriptions.save(row);
    return { subscribed: true };
  }

  async unsubscribe(userId: string, endpoint: string): Promise<{ removed: boolean }> {
    const result = await this.subscriptions.delete({ userId, endpoint });
    return { removed: Boolean(result.affected) };
  }

  async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    if (!this.isEnabled) return;
    const rows = await this.subscriptions.find({ where: { userId } });
    await Promise.all(
      rows.map(async (row) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: row.endpoint,
              keys: { p256dh: row.p256dh, auth: row.auth },
            },
            JSON.stringify(payload),
          );
        } catch (err: unknown) {
          const statusCode = (err as { statusCode?: number })?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await this.subscriptions.delete({ id: row.id });
            this.log.warn(`Removed stale push subscription ${row.id}`);
            return;
          }
          this.log.error(
            `Failed to send push subscription ${row.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }),
    );
  }
}
