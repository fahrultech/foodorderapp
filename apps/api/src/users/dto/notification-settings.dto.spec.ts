import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateNotificationSettingsDto } from './notification-settings.dto';

/** Same options the app boots with (src/main.ts) — this tests real stripping. */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: true });
const check = (value: any) =>
  pipe.transform(value, { metatype: UpdateNotificationSettingsDto, type: 'body' });

describe('UpdateNotificationSettingsDto (PATCH /users/me/notification-settings)', () => {
  it('accepts each boolean alone and both together', async () => {
    expect((await check({ orderEmail: false }) as any).orderEmail).toBe(false);
    expect((await check({ orderPush: true }) as any).orderPush).toBe(true);
    const all: any = await check({ orderEmail: false, orderPush: false });
    expect(all).toBeInstanceOf(UpdateNotificationSettingsDto);
    expect(all.orderEmail).toBe(false);
    expect(all.orderPush).toBe(false);
  });

  it('accepts an empty patch shape-wise (the service rejects it with 400)', async () => {
    expect(await check({})).toBeInstanceOf(UpdateNotificationSettingsDto);
  });

  it('rejects non-boolean values outright — no truthy coercion', async () => {
    // A typo'd client must 400, never quietly flip a channel: numbers,
    // strings and null are NOT booleans even though JS would coerce most.
    await expect(check({ orderEmail: 0 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(check({ orderEmail: 1 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(check({ orderEmail: 'false' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(check({ orderPush: null })).rejects.toBeInstanceOf(BadRequestException);
    await expect(check({ orderPush: [true] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('strips every key outside the two toggles (entity-named ones included)', async () => {
    const out: any = await check({
      orderEmail: false,
      orderEmailEnabled: false, // the sneaky entity-column name
      email: 'evil@b.com',
      role: 'admin',
      id: 'victim-uuid',
    });
    expect(out.orderEmail).toBe(false);
    for (const forbidden of ['orderEmailEnabled', 'orderPushEnabled', 'email', 'role', 'id']) {
      expect(out[forbidden]).toBeUndefined();
    }
  });
});
