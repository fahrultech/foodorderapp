import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SavePushSubscriptionDto, RemovePushSubscriptionDto } from './push-subscription.dto';

const valid = {
  endpoint: 'https://push.example.test/sub/1',
  keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
};

describe('push subscription DTOs', () => {
  it('accepts a complete browser PushSubscription JSON shape', async () => {
    const dto = plainToInstance(SavePushSubscriptionDto, valid);
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects a missing nested auth key', async () => {
    const dto = plainToInstance(SavePushSubscriptionDto, {
      ...valid,
      keys: { p256dh: 'p256dh-value' },
    });
    const errors = await validate(dto);
    expect(errors).not.toHaveLength(0);
    expect(errors[0].property).toBe('keys');
  });

  it('rejects non-https endpoint URLs', async () => {
    const dto = plainToInstance(SavePushSubscriptionDto, {
      ...valid,
      endpoint: 'javascript:alert(1)',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'endpoint')).toBe(true);
  });

  it('validates the unsubscribe endpoint body', async () => {
    await expect(validate(plainToInstance(RemovePushSubscriptionDto, { endpoint: valid.endpoint }))).resolves.toHaveLength(0);
    const errors = await validate(plainToInstance(RemovePushSubscriptionDto, { endpoint: '' }));
    expect(errors.some((e) => e.property === 'endpoint')).toBe(true);
  });
});
