import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TOKEN_TYPE_ACCESS } from './tokens';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('Missing bearer token');
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    // Same secret signs nothing but access tokens today, but asserting the
    // `typ` claim keeps the guard correct if a future token type ever shares it
    // — and rejects pre-refresh sessions that carry no `typ` at all.
    if (payload?.typ !== TOKEN_TYPE_ACCESS) {
      throw new UnauthorizedException('Not an access token');
    }
    req.user = payload;
    return true;
  }
}
