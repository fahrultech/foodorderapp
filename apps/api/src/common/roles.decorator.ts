import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../users/user.entity';

export const ROLES_KEY = 'roles';

/** Restricts a route to the given roles (checked by RolesGuard against the JWT payload). */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
