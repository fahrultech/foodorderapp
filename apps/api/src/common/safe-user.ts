import { User, UserRole } from '../users/user.entity';

/**
 * Client-facing user shape. Built as an explicit allowlist (not a spread with
 * `delete`) so a new sensitive column on `User` is never leaked by accident.
 */
export interface SafeUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  address: string | null;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone ?? null,
    address: user.address ?? null,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
