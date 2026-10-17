import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from './roles.decorator';
import { UserRole } from '../users/user.entity';

function ctx(user: any): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function build(required: UserRole[] | undefined) {
  const reflector: any = {
    getAllAndOverride: jest.fn((key: string) => (key === ROLES_KEY ? required : undefined)),
  };
  return new RolesGuard(reflector);
}

describe('RolesGuard', () => {
  it('allows when no @Roles metadata is present', () => {
    const guard = build(undefined);
    expect(guard.canActivate(ctx({ sub: 'u1', role: UserRole.CUSTOMER }))).toBe(true);
  });

  it('allows the required role', () => {
    const guard = build([UserRole.OWNER]);
    expect(guard.canActivate(ctx({ sub: 'u1', role: UserRole.OWNER }))).toBe(true);
  });

  it('denies a different role with 403', () => {
    const guard = build([UserRole.OWNER]);
    expect(() => guard.canActivate(ctx({ sub: 'u1', role: UserRole.CUSTOMER }))).toThrow(
      ForbiddenException,
    );
  });

  it('admin bypasses any required role', () => {
    const guard = build([UserRole.OWNER]);
    expect(guard.canActivate(ctx({ sub: 'u9', role: UserRole.ADMIN }))).toBe(true);
  });

  it('missing user (guard used without JwtAuthGuard) → 403', () => {
    const guard = build([UserRole.OWNER]);
    expect(() => guard.canActivate(ctx(undefined))).toThrow(ForbiddenException);
  });
});
