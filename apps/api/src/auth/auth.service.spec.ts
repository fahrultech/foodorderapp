import { AuthService } from './auth.service';
import { User, UserRole } from '../users/user.entity';

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'a@b.com',
    name: 'A',
    passwordHash: '',
    role: UserRole.CUSTOMER,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

function build() {
  const findOne = jest.fn();
  const create = jest.fn((x: any) => x);
  const save = jest.fn(async (x: any) => ({ ...fakeUser(), ...x }));
  const usersRepo: any = { findOne, create, save };
  const jwt: any = { signAsync: jest.fn(async () => 'token') };
  return { findOne, save, jwt, service: new AuthService(usersRepo, jwt) };
}

describe('AuthService', () => {
  it('register: rejects duplicate email', async () => {
    const { service } = build();
    const bcrypt = require('bcryptjs');
    const { ConflictException } = require('@nestjs/common');
    service['users'].findOne = jest.fn().mockResolvedValue(fakeUser());
    // rebuild with repo that returns existing user
    const repo: any = { findOne: jest.fn().mockResolvedValue(fakeUser()) };
    const svc = new AuthService(repo, { signAsync: jest.fn() } as any);
    await expect(
      svc.register({ email: 'a@b.com', name: 'A', password: 'password1' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
    void bcrypt;
  });

  it('register: returns token and omits passwordHash', async () => {
    const { service } = build();
    const result = await service.register({
      email: 'new@b.com',
      name: 'New',
      password: 'password1',
    } as any);
    expect(result.access_token).toBe('token');
    expect((result.user as any).passwordHash).toBeUndefined();
  });

  it('login: rejects unknown user', async () => {
    const repo: any = { findOne: jest.fn().mockResolvedValue(null) };
    const svc = new AuthService(repo, { signAsync: jest.fn() } as any);
    await expect(
      svc.login({ email: 'x@y.com', password: 'whatever' } as any),
    ).rejects.toThrow();
  });

  it('login: succeeds with correct password', async () => {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('secret123', 8);
    const repo: any = { findOne: jest.fn().mockResolvedValue(fakeUser({ passwordHash: hash })) };
    const svc = new AuthService(repo, { signAsync: jest.fn(async () => 'tok') } as any);
    const result = await svc.login({ email: 'a@b.com', password: 'secret123' } as any);
    expect(result.access_token).toBe('tok');
  });
});
