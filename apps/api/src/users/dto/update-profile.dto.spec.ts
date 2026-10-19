import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateProfileDto } from './update-profile.dto';

/** Same options the app boots with (src/main.ts) — this tests real stripping. */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: true });
const check = (value: any) =>
  pipe.transform(value, { metatype: UpdateProfileDto, type: 'body' });

describe('UpdateProfileDto (PATCH /users/me)', () => {
  it('accepts each field alone and all three together', async () => {
    expect((await check({ name: 'Ada' }) as any).name).toBe('Ada');
    expect((await check({ phone: '0811' }) as any).phone).toBe('0811');
    expect((await check({ address: 'Jl. Merdeka 1' }) as any).address).toBe('Jl. Merdeka 1');
    const all: any = await check({ name: 'Ada', phone: '0811', address: 'Jl. Merdeka 1' });
    expect(all).toBeInstanceOf(UpdateProfileDto);
  });

  it('accepts an empty patch shape-wise (the service rejects it with 400)', async () => {
    expect(await check({})).toBeInstanceOf(UpdateProfileDto);
  });

  it('allows clearing phone/address with an empty string', async () => {
    const out: any = await check({ phone: '', address: '' });
    expect(out.phone).toBe('');
    expect(out.address).toBe('');
  });

  it('rejects a blank or non-string name, and oversized fields', async () => {
    await expect(check({ name: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(check({ name: 42 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(check({ name: 'n'.repeat(121) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(check({ phone: 'p'.repeat(31) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(check({ address: 'a'.repeat(501) })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('strips every privileged or identity field a client might inject', async () => {
    const out: any = await check({
      name: 'Ada',
      email: 'evil@b.com',
      password: 'hunter2',
      passwordHash: 'x',
      role: 'admin',
      id: 'victim-uuid',
      createdAt: '2020-01-01',
    });
    expect(out.name).toBe('Ada');
    for (const forbidden of ['email', 'password', 'passwordHash', 'role', 'id', 'createdAt']) {
      expect(out[forbidden]).toBeUndefined();
    }
  });
});
