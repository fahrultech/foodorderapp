import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import * as webpush from 'web-push';
import { PushService } from './push.service';
import { PushSubscription } from './push-subscription.entity';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));

const setVapidDetails = webpush.setVapidDetails as jest.Mock;
const sendNotification = webpush.sendNotification as jest.Mock;

function config(values: Record<string, string | undefined>) {
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function repo(overrides: Partial<Repository<PushSubscription>> = {}) {
  return {
    findOne: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
    delete: jest.fn(async () => ({ affected: 1 })),
    find: jest.fn(async () => []),
    ...overrides,
  } as unknown as Repository<PushSubscription>;
}

const dto = {
  endpoint: 'https://push.example.test/sub/1',
  keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
};

describe('PushService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is disabled when the VAPID triplet is absent', async () => {
    const subscriptions = repo();
    const service = new PushService(config({}), subscriptions);

    expect(service.getConfig()).toEqual({ enabled: false, publicKey: null });
    await service.sendToUser('user-1', { title: 'Updated', body: 'Ready', url: '/orders/1', tag: 'order-1' });

    expect(setVapidDetails).not.toHaveBeenCalled();
    expect(subscriptions.find).not.toHaveBeenCalled();
  });

  it('configures VAPID and exposes only the public key', () => {
    const service = new PushService(
      config({ VAPID_SUBJECT: 'mailto:ops@example.test', VAPID_PUBLIC_KEY: 'public-key', VAPID_PRIVATE_KEY: 'private-key' }),
      repo(),
    );

    expect(setVapidDetails).toHaveBeenCalledWith('mailto:ops@example.test', 'public-key', 'private-key');
    expect(service.getConfig()).toEqual({ enabled: true, publicKey: 'public-key' });
  });

  it('upserts an endpoint and transfers it to the signed-in user', async () => {
    const existing = { id: 'sub-1', userId: 'old-user', endpoint: dto.endpoint, p256dh: 'old', auth: 'old' } as PushSubscription;
    const subscriptions = repo({ findOne: jest.fn(async () => existing) });
    const service = new PushService(
      config({ VAPID_SUBJECT: 'mailto:ops@example.test', VAPID_PUBLIC_KEY: 'public-key', VAPID_PRIVATE_KEY: 'private-key' }),
      subscriptions,
    );

    await expect(service.subscribe('new-user', dto)).resolves.toEqual({ subscribed: true });
    expect(existing).toMatchObject({ userId: 'new-user', endpoint: dto.endpoint, p256dh: dto.keys.p256dh, auth: dto.keys.auth });
    expect(subscriptions.save).toHaveBeenCalledWith(existing);
  });

  it('unsubscribes only the current user endpoint', async () => {
    const subscriptions = repo();
    const service = new PushService(config({}), subscriptions);

    await expect(service.unsubscribe('user-1', dto.endpoint)).resolves.toEqual({ removed: true });
    expect(subscriptions.delete).toHaveBeenCalledWith({ userId: 'user-1', endpoint: dto.endpoint });
  });

  it('sends JSON to every user subscription and deletes stale endpoints', async () => {
    const rows = [
      { id: 'sub-1', userId: 'user-1', ...dto.keys, endpoint: dto.endpoint },
      { id: 'sub-2', userId: 'user-1', ...dto.keys, endpoint: 'https://push.example.test/sub/2' },
    ] as PushSubscription[];
    const subscriptions = repo({ find: jest.fn(async () => rows) });
    sendNotification
      .mockRejectedValueOnce({ statusCode: 410 })
      .mockResolvedValueOnce({});
    const service = new PushService(
      config({ VAPID_SUBJECT: 'mailto:ops@example.test', VAPID_PUBLIC_KEY: 'public-key', VAPID_PRIVATE_KEY: 'private-key' }),
      subscriptions,
    );
    const payload = { title: 'Order update', body: 'On its way', url: '/orders/order-1', tag: 'order-order-1' };

    await service.sendToUser('user-1', payload);

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(JSON.parse(sendNotification.mock.calls[0][1])).toEqual(payload);
    expect(subscriptions.delete).toHaveBeenCalledWith({ id: 'sub-1' });
  });
});
