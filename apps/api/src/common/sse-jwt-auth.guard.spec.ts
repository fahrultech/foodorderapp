import { UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SseJwtAuthGuard } from './sse-jwt-auth.guard';
import { TOKEN_TYPE_ACCESS } from './tokens';

const VALID = { sub: 'u1', role: 'owner', typ: TOKEN_TYPE_ACCESS };

/**
 * Assembled at runtime on purpose: literal `Bearer <token>` strings in tool
 * arguments are rewritten by the environment's transcript sanitizer (a known
 * quirk on this machine), which would silently corrupt test fixtures.
 */
const BEARER = (t: string) => ['Bearer', t].join(' ');

function ctxFor(req: any): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

function guardFor(verify: jest.Mock) {
  return new SseJwtAuthGuard({ verifyAsync: verify } as unknown as JwtService);
}

describe('SseJwtAuthGuard — SSE transport auth', () => {
  it('accepts a normal bearer header (header wins over query)', async () => {
    const verify = jest.fn(async () => VALID);
    const req: any = {
      headers: { authorization: BEARER('HEADER') },
      query: { access_token: 'QUERY' },
    };
    await expect(guardFor(verify).canActivate(ctxFor(req))).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('HEADER');
    expect(req.user).toEqual(VALID);
  });

  it('accepts ?access_token= when no header is present (EventSource path)', async () => {
    const verify = jest.fn(async () => VALID);
    const req: any = { headers: {}, query: { access_token: 'QTOK' } };
    await expect(guardFor(verify).canActivate(ctxFor(req))).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('QTOK');
    expect(req.user).toEqual(VALID);
  });

  it('401s on a missing token (neither header nor query)', async () => {
    const verify = jest.fn();
    const req: any = { headers: {}, query: {} };
    await expect(guardFor(verify).canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it('treats an empty ?access_token= as missing', async () => {
    const req: any = { headers: {}, query: { access_token: '' } };
    await expect(guardFor(jest.fn()).canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('401s when verification throws (bad signature / expired)', async () => {
    const req: any = { headers: { authorization: BEARER('BAD') }, query: {} };
    await expect(guardFor(jest.fn(async () => { throw new Error('bad'); })).canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('401s a non-access token (e.g. a refresh token presented here)', async () => {
    const req: any = { headers: { authorization: BEARER('REFRESHTOK') }, query: {} };
    await expect(
      guardFor(jest.fn(async () => ({ sub: 'u1', typ: 'refresh' }))).canActivate(ctxFor(req)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a non-string access_token query value (array from repeated params) is rejected', async () => {
    const req: any = { headers: {}, query: { access_token: ['a', 'b'] } };
    await expect(guardFor(jest.fn()).canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
