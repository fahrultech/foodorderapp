import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { User, UserRole } from './user.entity';

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'a@b.com',
    name: 'A',
    phone: '0811',
    address: 'Jl. Merdeka 1',
    passwordHash: 'hashed',
    role: UserRole.CUSTOMER,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as User;
}

function build(options: { stored?: User; affected?: number } = {}) {
  const stored = options.stored ?? fakeUser();
  const update = jest.fn(async (id: string, data: any) => {
    Object.assign(stored, data);
    return { affected: options.affected ?? 1 };
  });
  const repo: any = { update, findOne: jest.fn(async () => stored) };
  return { stored, update, repo, service: new UsersService(repo) };
}

describe('UsersService.updateProfile (PATCH /users/me)', () => {
  it('applies only the allowlisted fields that were provided', async () => {
    const h = build();
    const result = await h.service.updateProfile('u1', { name: 'Ada' });

    expect(h.update).toHaveBeenCalledWith('u1', { name: 'Ada' });
    expect(result).toEqual({
      id: 'u1',
      email: 'a@b.com',
      name: 'Ada',
      phone: '0811',
      address: 'Jl. Merdeka 1',
      role: UserRole.CUSTOMER,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect((result as any).passwordHash).toBeUndefined();
  });

  it('updates name, phone and address together', async () => {
    const h = build();
    await h.service.updateProfile('u1', {
      name: 'Ada',
      phone: '0812-9999',
      address: 'Jl. Sudirman 42',
    });
    expect(h.update).toHaveBeenCalledWith('u1', {
      name: 'Ada',
      phone: '0812-9999',
      address: 'Jl. Sudirman 42',
    });
    expect(h.stored.name).toBe('Ada');
    expect(h.stored.address).toBe('Jl. Sudirman 42');
  });

  it('clears a phone/address with an empty string but never clears a name', async () => {
    const h = build();
    await h.service.updateProfile('u1', { name: 'Ada', phone: '', address: '' });
    expect(h.update).toHaveBeenCalledWith('u1', { name: 'Ada', phone: '', address: '' });
    expect(h.stored.phone).toBe('');
  });

  it('400s on an empty patch instead of pretending to save', async () => {
    const h = build();
    await expect(h.service.updateProfile('u1', {})).rejects.toBeInstanceOf(BadRequestException);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('400s when the body carries only unlisted keys (email/role/passwordHash ignored)', async () => {
    const h = build();
    const sneaky = { email: 'evil@b.com', role: UserRole.ADMIN, passwordHash: 'x' } as any;
    await expect(h.service.updateProfile('u1', sneaky)).rejects.toThrow(/No profile fields/);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.stored.email).toBe('a@b.com');
    expect(h.stored.role).toBe(UserRole.CUSTOMER);
  });

  it('404s when the UPDATE matches no row (deleted account mid-request)', async () => {
    const h = build({ affected: 0 });
    await expect(h.service.updateProfile('gone', { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s when the row disappears between UPDATE and the re-read', async () => {
    const h = build();
    h.repo.findOne = jest.fn(async () => null);
    await expect(h.service.updateProfile('u1', { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('findById returns the stored row for internal callers', async () => {
    const h = build();
    await expect(h.service.findById('u1')).resolves.toMatchObject({ id: 'u1' });
    expect(h.repo.findOne).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });
});
