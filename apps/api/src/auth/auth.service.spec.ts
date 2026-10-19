import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService, hashToken } from './auth.service';
import { ACCESS_TTL_DEFAULT, TOKEN_TYPE_ACCESS } from '../common/tokens';
import { User, UserRole } from '../users/user.entity';
import { SessionStore } from './testing/session-store';

const PASSWORD = 'password1';
/** cost 4 keeps the suite fast while exercising the real compare() path. */
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'a@b.com',
    name: 'A',
    phone: null,
    address: null,
    passwordHash: PASSWORD_HASH,
    role: UserRole.CUSTOMER,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as User;
}

interface Harness {
  users: any;
  store: SessionStore;
  jwt: any;
  service: AuthService;
}

/** Fake JwtService: records the payload/options instead of signing. */
function build(options: { user?: User; config?: Record<string, string> } = {}): Harness {
  const user = options.user ?? fakeUser();
  const users: any = {
    findOne: jest.fn(async ({ where }: any) =>
      where.email ? (where.email === user.email ? user : null) : where.id === user.id ? user : null,
    ),
    create: jest.fn((x: any) => ({ ...user, ...x })),
    save: jest.fn(async (x: any) => ({ ...user, ...x })),
  };
  const store = new SessionStore();
  const jwt: any = {
    signAsync: jest.fn(async (payload: any, opts: any) => {
      jwt.lastPayload = payload;
      jwt.lastOptions = opts;
      return `jwt.${payload.sub}`;
    }),
  };
  const config: any = { get: (key: string) => options.config?.[key] };
  return { users, store, jwt, service: new AuthService(users, store.repo, jwt, config) };
}

/** One live session for the harness user. */
const session = (h: Harness) => h.service.login({ email: 'a@b.com', password: PASSWORD } as any);

describe('AuthService — register', () => {
  it('rejects a duplicate email before hashing or issuing anything', async () => {
    const h = build();
    await expect(
      h.service.register({ email: 'a@b.com', name: 'A', password: PASSWORD } as any),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.jwt.signAsync).not.toHaveBeenCalled();
    expect(h.store.rows).toHaveLength(0);
  });

  it('issues an access+refresh pair and never returns passwordHash', async () => {
    const h = build();
    const result = await h.service.register({
      email: 'new@b.com',
      name: 'New',
      password: PASSWORD,
    } as any);

    expect(result.access_token).toBe('jwt.u1');
    expect(result.token_type).toBe('Bearer');
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result.user.id).toBe('u1');
    const created = h.users.create.mock.calls[0][0];
    expect(created).toMatchObject({ email: 'new@b.com', name: 'New' });
    expect(created.passwordHash).not.toBe(PASSWORD); // bcrypt output, never the raw password
    expect(created.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it('stores only the sha256 digest of the refresh token', async () => {
    const h = build();
    const issued = await session(h);

    expect(issued.refresh_token).toEqual(expect.any(String));
    expect(issued.refresh_token.split('.')).toHaveLength(1); // opaque, not a JWT
    expect(h.store.rows).toHaveLength(1);
    const row = h.store.rows[0];
    expect(row.tokenHash).toBe(hashToken(issued.refresh_token));
    expect(row.tokenHash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(issued.refresh_token);
    expect(row.userId).toBe('u1');
    expect(row.revokedAt).toBeNull();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('gives every session a distinct refresh token', async () => {
    const h = build();
    const a = await session(h);
    const b = await session(h);
    expect(a.refresh_token).not.toBe(b.refresh_token);
    expect(h.store.rows).toHaveLength(2);
  });
});

describe('AuthService — login', () => {
  it('rejects an unknown email', async () => {
    const h = build();
    await expect(
      h.service.login({ email: 'nobody@b.com', password: PASSWORD } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a wrong password with the same message as an unknown account', async () => {
    const h = build();
    const err: any = await h.service
      .login({ email: 'a@b.com', password: 'wrong-one' } as any)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe('Invalid email or password');
    expect(h.jwt.signAsync).not.toHaveBeenCalled();
  });

  it('succeeds and signs an access-typed claim set with the default TTL', async () => {
    const h = build({ user: fakeUser({ role: UserRole.OWNER }) });
    const result = await h.service.login({ email: 'a@b.com', password: PASSWORD } as any);

    expect(result.access_token).toBe('jwt.u1');
    expect(h.jwt.lastPayload).toEqual({
      sub: 'u1',
      email: 'a@b.com',
      role: UserRole.OWNER,
      name: 'A',
      typ: TOKEN_TYPE_ACCESS,
    });
    expect(h.jwt.lastOptions).toEqual({ expiresIn: ACCESS_TTL_DEFAULT });
    expect(result.expires_in).toBe(30 * 60);
  });

  it('honours JWT_ACCESS_TTL and JWT_REFRESH_TTL overrides', async () => {
    const h = build({ config: { JWT_ACCESS_TTL: '2h', JWT_REFRESH_TTL: '7d' } });
    const before = Date.now();
    const result = await h.service.login({ email: 'a@b.com', password: PASSWORD } as any);

    expect(h.jwt.lastOptions).toEqual({ expiresIn: '2h' });
    expect(result.expires_in).toBe(2 * 3600);
    const ttlMs = new Date(result.refresh_expires_at).getTime() - before;
    expect(ttlMs).toBeGreaterThanOrEqual(7 * 86_400_000 - 5_000);
    expect(ttlMs).toBeLessThanOrEqual(7 * 86_400_000 + 5_000);
  });

  it('fails loudly on a malformed TTL instead of minting an endless session', async () => {
    const h = build({ config: { JWT_REFRESH_TTL: 'seven days' } });
    await expect(
      h.service.login({ email: 'a@b.com', password: PASSWORD } as any),
    ).rejects.toThrow(/Invalid duration/);
    expect(h.store.rows).toHaveLength(0); // no session stored on the failed issue
  });
});

describe('AuthService — refresh (rotation + reuse detection)', () => {
  it('exchanges a live token for a new pair and revokes the presented one', async () => {
    const h = build();
    const first = await session(h);
    const second = await h.service.refresh(first.refresh_token);

    expect(second.access_token).toBe('jwt.u1');
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(h.store.rows).toHaveLength(2);
    expect(h.store.byHash(hashToken(first.refresh_token)).revokedAt).toBeInstanceOf(Date);
    expect(h.store.byHash(hashToken(second.refresh_token)).revokedAt).toBeNull();
    expect(h.store.live()).toHaveLength(1);
  });

  it('a replayed token revokes every session of the user', async () => {
    const h = build();
    const first = await session(h);
    const second = await h.service.refresh(first.refresh_token);
    const third = await session(h); // a legit parallel device

    const err: any = await h.service.refresh(first.refresh_token).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toMatch(/reuse detected/i);
    expect(err.message).toMatch(/2 session\(s\) revoked/);
    expect(h.store.live()).toHaveLength(0);
    expect(h.store.byHash(hashToken(second.refresh_token)).revokedAt).toBeInstanceOf(Date);
    expect(h.store.byHash(hashToken(third.refresh_token)).revokedAt).toBeInstanceOf(Date);
  });

  it('rejects a token it never issued', async () => {
    const h = build();
    await expect(h.service.refresh('not-a-real-token')).rejects.toThrow(/Unknown refresh token/);
  });

  it('rejects an empty token without touching the store', async () => {
    const h = build();
    await expect(h.service.refresh('')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.store.rows).toHaveLength(0);
  });

  it('rejects an expired token and leaves the row unredeemed', async () => {
    const store = new SessionStore([
      {
        tokenHash: hashToken('old-token'),
        userId: 'u1',
        expiresAt: new Date(Date.now() - 1),
        revokedAt: null,
      },
    ]);
    const h = build();
    (h.service as any).sessions = store.repo;
    await expect(h.service.refresh('old-token')).rejects.toThrow(/expired/i);
    expect(store.rows[0].revokedAt).toBeNull();
    expect(h.jwt.signAsync).not.toHaveBeenCalled();
  });

  it('rejects the session of a deleted account and revokes the row', async () => {
    const h = build();
    const issued = await session(h);
    h.users.findOne = jest.fn(async () => null); // account gone
    await expect(h.service.refresh(issued.refresh_token)).rejects.toThrow(
      /Account no longer exists/,
    );
    expect(h.store.rows[0].revokedAt).toBeInstanceOf(Date);
  });

  it('carries the current role into the refreshed access token', async () => {
    const h = build({ user: fakeUser({ role: UserRole.ADMIN }) });
    const issued = await session(h);
    const refreshed = await h.service.refresh(issued.refresh_token);
    expect(h.jwt.lastPayload.role).toBe(UserRole.ADMIN);
    expect(refreshed.user.role).toBe(UserRole.ADMIN);
  });
});

describe('AuthService — logout', () => {
  it('revokes exactly the presented session of the caller', async () => {
    const h = build();
    const mine = await session(h);
    const other = await session(h);

    const result = await h.service.logout('u1', { refresh_token: mine.refresh_token });
    expect(result).toEqual({ success: true, revoked_sessions: 1 });
    expect(h.store.byHash(hashToken(mine.refresh_token)).revokedAt).toBeInstanceOf(Date);
    expect(h.store.byHash(hashToken(other.refresh_token)).revokedAt).toBeNull();
  });

  it('does not let one caller revoke another user’s session', async () => {
    const h = build();
    const issued = await session(h);
    const result = await h.service.logout('someone-else', {
      refresh_token: issued.refresh_token,
    });
    expect(result.revoked_sessions).toBe(0);
    expect(h.store.rows[0].revokedAt).toBeNull();
  });

  it('revokes every session with all:true, and with no body at all', async () => {
    const h = build();
    await session(h);
    await session(h);
    expect(h.store.live()).toHaveLength(2);

    expect(await h.service.logout('u1', { all: true })).toEqual({
      success: true,
      revoked_sessions: 2,
    });
    expect(h.store.live()).toHaveLength(0);

    await session(h);
    expect(await h.service.logout('u1', {})).toEqual({ success: true, revoked_sessions: 1 });
  });

  it('all:true wins over a single refresh_token (bigger hammer)', async () => {
    const h = build();
    const a = await session(h);
    await session(h);
    expect(await h.service.logout('u1', { refresh_token: a.refresh_token, all: true })).toEqual({
      success: true,
      revoked_sessions: 2,
    });
  });

  it('is idempotent: an already-revoked or unknown token still succeeds', async () => {
    const h = build();
    const issued = await session(h);
    await h.service.logout('u1', { refresh_token: issued.refresh_token });
    expect(await h.service.logout('u1', { refresh_token: issued.refresh_token })).toEqual({
      success: true,
      revoked_sessions: 0,
    });
    expect(await h.service.logout('u1', { refresh_token: 'never-issued' })).toEqual({
      success: true,
      revoked_sessions: 0,
    });
    expect(h.store.rows).toHaveLength(1);
  });

  it('a revoked session can no longer be refreshed', async () => {
    const h = build();
    const issued = await session(h);
    await h.service.logout('u1', { refresh_token: issued.refresh_token });
    await expect(h.service.refresh(issued.refresh_token)).rejects.toThrow(/reuse detected/i);
  });
});

describe('AuthService — me', () => {
  it('re-reads the profile from the database instead of echoing token claims', async () => {
    const h = build({ user: fakeUser({ name: 'Stored Name' }) });
    const me = await h.service.me({ sub: 'u1' });
    expect(me).toEqual({
      id: 'u1',
      email: 'a@b.com',
      name: 'Stored Name',
      phone: null,
      address: null,
      role: UserRole.CUSTOMER,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect((me as any).passwordHash).toBeUndefined();
  });

  it('401s when the account is gone or the claims have no subject', async () => {
    const h = build();
    await expect(h.service.me({ sub: 'ghost' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(h.service.me({})).rejects.toThrow(/Missing subject claim/);
    await expect(h.service.me(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
