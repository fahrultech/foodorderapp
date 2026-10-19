import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { LoginDto, LogoutDto, RefreshDto, RegisterDto } from './auth.dto';

/** Same options the app boots with (src/main.ts) — this tests real stripping. */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: true });
const check = (dto: any, value: any) => pipe.transform(value, { metatype: dto, type: 'body' });

describe('Auth DTOs — validation via the global ValidationPipe', () => {
  describe('RefreshDto', () => {
    it('accepts an opaque token string', async () => {
      const out: any = await check(RefreshDto, { refresh_token: 'abc_-9Zk' });
      expect(out).toBeInstanceOf(RefreshDto);
      expect(out.refresh_token).toBe('abc_-9Zk');
    });

    it('rejects missing, blank, non-string and absurdly long tokens', async () => {
      for (const body of [
        {},
        { refresh_token: '' },
        { refresh_token: 123 },
        { refresh_token: null },
        { refresh_token: 'x'.repeat(513) },
      ]) {
        await expect(check(RefreshDto, body)).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('strips injected fields (a refresh body carries nothing else)', async () => {
      const out: any = await check(RefreshDto, {
        refresh_token: 'tok',
        userId: 'victim',
        role: 'admin',
      });
      expect(out.userId).toBeUndefined();
      expect(out.role).toBeUndefined();
    });
  });

  describe('LogoutDto', () => {
    it('accepts an empty body, a token, all:true, or both', async () => {
      for (const body of [
        {},
        { refresh_token: 'tok' },
        { all: true },
        { all: false },
        { refresh_token: 'tok', all: true },
      ]) {
        const out: any = await check(LogoutDto, body);
        expect(out).toBeInstanceOf(LogoutDto);
      }
    });

    it('rejects a non-boolean `all` and a blank token', async () => {
      for (const body of [
        { all: 'yes' },
        { all: 1 },
        { refresh_token: '' },
        { refresh_token: 42 },
      ]) {
        await expect(check(LogoutDto, body)).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('strips anything the DTO does not declare', async () => {
      const out: any = await check(LogoutDto, { all: true, email: 'a@b.com', role: 'admin' });
      expect(out.email).toBeUndefined();
      expect(out.role).toBeUndefined();
    });
  });

  describe('RegisterDto', () => {
    it('accepts a valid registration and keeps optional contact fields', async () => {
      const out: any = await check(RegisterDto, {
        email: 'a@b.com',
        name: 'Ada',
        password: 'password1',
        phone: '0811',
        address: 'Jl. Merdeka 1',
      });
      expect(out.phone).toBe('0811');
      expect(out.address).toBe('Jl. Merdeka 1');
    });

    it('rejects bad email, short name, short password and oversized fields', async () => {
      const base = { email: 'a@b.com', name: 'Ada', password: 'password1' };
      await expect(check(RegisterDto, { ...base, email: 'not-an-email' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(check(RegisterDto, { ...base, name: 'A' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(check(RegisterDto, { ...base, password: 'short1' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(check(RegisterDto, { ...base, phone: 'p'.repeat(31) })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        check(RegisterDto, { ...base, address: 'a'.repeat(501) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('strips privilege fields: role and id cannot be self-assigned', async () => {
      const out: any = await check(RegisterDto, {
        email: 'a@b.com',
        name: 'Ada',
        password: 'password1',
        role: 'admin',
        id: 'fixed-uuid',
      });
      expect(out.role).toBeUndefined();
      expect(out.id).toBeUndefined();
    });
  });

  describe('LoginDto', () => {
    it('requires an email and a password', async () => {
      await expect(check(LoginDto, { email: 'a@b.com', password: 'x' })).resolves.toBeInstanceOf(
        LoginDto,
      );
      await expect(check(LoginDto, { email: 'nope', password: 'x' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(check(LoginDto, { email: 'a@b.com' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(check(LoginDto, { email: 'a@b.com', password: '' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
