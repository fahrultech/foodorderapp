import { NotificationsController } from './notifications.controller';
import { PushService } from './push.service';

const dto = {
  endpoint: 'https://push.example.test/sub/1',
  keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
};

describe('NotificationsController', () => {
  it('returns public push configuration', () => {
    const service = { getConfig: jest.fn(() => ({ enabled: false, publicKey: null })) } as unknown as PushService;
    const controller = new NotificationsController(service);
    expect(controller.config()).toEqual({ enabled: false, publicKey: null });
  });

  it('scopes subscribe and unsubscribe to the JWT subject', async () => {
    const service = {
      subscribe: jest.fn(async () => ({ subscribed: true })),
      unsubscribe: jest.fn(async () => ({ removed: true })),
    } as unknown as PushService;
    const controller = new NotificationsController(service);
    const actor = { sub: 'user-1', email: 'alice@example.test' };

    await expect(controller.subscribe(dto, actor)).resolves.toEqual({ subscribed: true });
    await expect(controller.unsubscribe({ endpoint: dto.endpoint }, actor)).resolves.toEqual({ removed: true });
    expect(service.subscribe).toHaveBeenCalledWith('user-1', dto);
    expect(service.unsubscribe).toHaveBeenCalledWith('user-1', dto.endpoint);
  });
});
