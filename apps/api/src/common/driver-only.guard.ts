import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { UserRole } from '../users/user.entity';

/** Exact role gate for courier endpoints; unlike RolesGuard, ADMIN does not bypass. */
@Injectable()
export class DriverOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user;
    if (user?.role !== UserRole.DRIVER) {
      throw new ForbiddenException('Driver role required');
    }
    return true;
  }
}
