import { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { TOKEN_TYPE_ACCESS } from './tokens';

const SECRET = 'optional-guard-secret';
const signer = (secret = SECRET) => new JwtService({ secret });

function ctxWithHeader(header: string | undefined, jwt: JwtService = signer()) {
  const req: any = { headers: header === undefined ? {} : { authorization: header } };
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { req, guard: new OptionalJwtAuthGuard(jwt), context };
}

describe('OptionalJwtAuthGuard', () => {
  it('attaches req.user for a valid access token', async () => {
    const { req, guard, context } = ctxWithHeader(undefined);
    const token = await signer().signAsync(
      { sub: 'u1', role: 'customer', typ: TOKEN_TYPE_ACCESS },
      { expiresIn: '30m' },
    );
    req.headers.authorization = `Bearer ${token}`;
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toMatchObject({ sub: 'u1', typ: TOKEN_TYPE_ACCESS });
  });

  it('proceeds as guest (req.user unset) with no header', async () => {
    const { req, guard, context } = ctxWithHeader(undefined);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('proceeds as guest on a non-Bearer, empty or malformed scheme', async () => {
    for (const header of ['Basic dXNlcjpwYXNz', 'Bearer ', 'Token abc', 'not a header']) {
      const { req, guard, context } = ctxWithHeader(header);
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(req.user).toBeUndefined();
    }
  });

  it('proceeds as guest (no throw) when the token is signed with the wrong secret', async () => {
    const token = await signer('other-secret').signAsync(
      { sub: 'u1', typ: TOKEN_TYPE_ACCESS },
      { expiresIn: '30m' },
    );
    const { req, guard, context } = ctxWithHeader(`Bearer ${token}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('proceeds as guest on an expired token', async () => {
    const token = await signer().signAsync(
      { sub: 'u1', typ: TOKEN_TYPE_ACCESS },
      { expiresIn: '-5s' },
    );
    const { req, guard, context } = ctxWithHeader(`Bearer ${token}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('proceeds as guest on a token that is not an access token (wrong typ)', async () => {
    const token = await signer().signAsync(
      { sub: 'u1', typ: 'refresh' },
      { expiresIn: '30m' },
    );
    const { req, guard, context } = ctxWithHeader(`Bearer ${token}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toBeUndefined();
  });
});
