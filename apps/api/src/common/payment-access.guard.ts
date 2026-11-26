import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * Payment rung guard (Phase 15 #3 — "one-click pay from the magic link").
 *
 * Payments stay an AUTHENTICATED action: a `Bearer` header is verified
 * EXACTLY like `JwtAuthGuard` (an invalid/expired bearer 401s — the caller
 * tried to authenticate and is never silently downgraded to a guest rung).
 * The new arm: a request with NO Authorization header but WITH an `rt`
 * query parameter PRESENTED is admitted to the controller so the service
 * can verify the magic-link capability (verification needs the loaded
 * order/payment row, so it lives in the ladder, not the guard).
 *
 * Baselines this deliberately preserves:
 * - anonymous WITHOUT any presented `rt` → the byte-identical
 *   401 'Missing bearer token' envelope of session 47's pins (the
 *   service is never touched);
 * - anonymous WITH any `rt` presentation (junk, foreign, expired,
 *   repeated-key array transport) → the canonical 404 of session 133/135's
 *   no-oracle baseline, produced by the service-level verification.
 *
 * The guard checks PRESENCE only (`'rt' in req.query`), never validity —
 * a repeated `?rt=a&rt=b` arrives as an ARRAY pre-pipe (session-132 wire
 * truth), passes presence here, is String()-coerced by the global pipe,
 * and DENIES at the pure verifier.
 */
@Injectable()
export class PaymentAccessGuard extends JwtAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string = req.headers?.['authorization'] ?? '';
    if (header.startsWith('Bearer ')) {
      // A bearer attempt is a bearer attempt: valid attaches req.user,
      // invalid/expired keeps the untouched JwtAuthGuard 401 semantics.
      return super.canActivate(context);
    }
    if (req.query && 'rt' in req.query && req.query.rt != null) {
      return true; // capability presented — the service ladder verifies it
    }
    throw new UnauthorizedException('Missing bearer token');
  }
}
