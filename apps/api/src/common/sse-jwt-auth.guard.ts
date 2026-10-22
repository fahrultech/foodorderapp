import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TOKEN_TYPE_ACCESS } from './tokens';

/**
 * Auth for Server-Sent-Event routes. Browser `EventSource` cannot set an
 * Authorization header, so the access token may also arrive as the
 * `access_token` query parameter. Verification is otherwise IDENTICAL to
 * JwtAuthGuard: same secret, `typ === 'access'` claim required, `req.user`
 * populated the same way — so RolesGuard and @CurrentUser keep working.
 *
 * Security tradeoff (documented in docs/ARCHITECTURE.md): a token in the URL
 * can end up in proxy/server access logs. Mitigations: only the SSE route
 * accepts it, tokens are short-lived (JWT_ACCESS_TTL, default 30m), and the
 * Authorization header STILL wins when both are present — ordinary API clients
 * (curl, tests) never need the query form. Deployments with strict log hygiene
 * sit behind TLS.
 */
@Injectable()
export class SseJwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException('Missing bearer token');
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (payload?.typ !== TOKEN_TYPE_ACCESS) {
      throw new UnauthorizedException('Not an access token');
    }
    req.user = payload;
    return true;
  }

  /** Header first (never log-worthy), query param as the EventSource fallback. */
  private extractToken(req: any): string | null {
    const header: string = req.headers?.['authorization'] || '';
    if (header.startsWith('Bearer ')) return header.slice(7);
    const q = req.query?.access_token;
    return typeof q === 'string' && q.length > 0 ? q : null;
  }
}
