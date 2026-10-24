import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Self-service profile edit (`PATCH /users/me`).
 *
 * Allowlist on purpose: `email` (identity + login), `role` (authorization) and
 * `passwordHash` are not settable here — email change needs a verification
 * flow, role changes are admin-only, and a password change must verify the old
 * password. `phone`/`address` accept `""` so a saved value can be cleared.
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ maxLength: 30, description: 'Empty string clears the saved value' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'Empty string clears the saved value' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;
}
