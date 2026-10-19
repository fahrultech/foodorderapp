import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * For routes that work for guests but get *better* with a session: a valid
 * access token attaches `req.user`; anything else (no header, malformed,
 * expired, wrong typ) silently proceeds as a guest instead of 401-ing.
 * Never use this where the handler trusts identity for authorization —
 * that is what `JwtAuthGuard` (+ RolesGuard) is for.
 */
@Injectable()
export class OptionalJwtAuthGuard extends JwtAuthGuard implements CanActivate {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string = req.headers?.authorization ?? '';
    if (!header.startsWith('Bearer ')) return true; // guest
    try {
      return await super.canActivate(context);
    } catch {
      return true; // stale/invalid token on a public route → treat as guest
    }
  }
}
