import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TOKEN_TYPE_ACCESS } from './tokens';

/** Real JwtService: signatures, expiry and claim checks are genuinely exercised. */
const SECRET = 'guard-spec-secret';
const signer = (secret = SECRET) => new JwtService({ secret });

function ctxWithHeader(header: string | undefined, jwt: JwtService = signer()) {
  const req: any = { headers: header === undefined ? {} : { authorization: header } };
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { req, guard: new JwtAuthGuard(jwt), context };
}

describe('JwtAuthGuard', () => {
  it('accepts a valid access token and attaches its claims to the request', async () => {
    const { req, guard, context } = ctxWithHeader('Bearer fake');
    const token = await signer().signAsync(
      { sub: 'u1', email: 'a@b.com', role: 'customer', typ: TOKEN_TYPE_ACCESS },
      { expiresIn: '30m' },
    );
    req.headers.authorization = `Bearer ${token}`;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toMatchObject({ sub: 'u1', email: 'a@b.com', typ: TOKEN_TYPE_ACCESS });
    expect(req.user).not.toHaveProperty('passwordHash');
  });

  it('rejects a missing Authorization header', async () => {
    const { guard, context } = ctxWithHeader(undefined);
    await expect(guard.canActivate(context)).rejects.toThrow(/Missing bearer token/);
  });

  it('rejects a non-Bearer scheme and an empty bearer', async () => {
    for (const header of ['Basic dXNlcjpwYXNz', 'Bearer ', 'Token abc123']) {
      const { guard, context } = ctxWithHeader(header);
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signer('other-secret').signAsync(
      { sub: 'u1', typ: TOKEN_TYPE_ACCESS },
      { expiresIn: '30m' },
    );
    const { guard, context } = ctxWithHeader(`Bearer ${token}`);
    await expect(guard.canActivate(context)).rejects.toThrow(/Invalid or expired token/);
  });

  it('rejects an expired token', async () => {
    const token = await signer().signAsync(
      { sub: 'u1', typ: TOKEN_TYPE_ACCESS },
      { expiresIn: -10 },
    );
    const { guard, context } = ctxWithHeader(`Bearer ${token}`);
    await expect(guard.canActivate(context)).rejects.toThrow(/Invalid or expired token/);
  });

  it('rejects a token without the access `typ` claim (pre-refresh sessions)', async () => {
    const token = await signer().signAsync({ sub: 'u1', email: 'a@b.com' }, { expiresIn: '30m' });
    const { guard, context } = ctxWithHeader(`Bearer ${token}`);
    await expect(guard.canActivate(context)).rejects.toThrow(/Not an access token/);
  });

  it('rejects a token typed as something else', async () => {
    for (const typ of ['refresh', 'reset-password', 'access ']) {
      const token = await signer().signAsync({ sub: 'u1', typ }, { expiresIn: '30m' });
      const { guard, context } = ctxWithHeader(`Bearer ${token}`);
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('does not leave a half-populated req.user when it rejects', async () => {
    const token = await signer().signAsync({ sub: 'u1' }, { expiresIn: '30m' });
    const { req, guard, context } = ctxWithHeader(`Bearer ${token}`);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(req.user).toBeUndefined();
  });
});
