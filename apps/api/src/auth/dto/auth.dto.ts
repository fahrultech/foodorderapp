import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'rudi@example.com', description: 'Unique login email' })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 2, maxLength: 120, example: 'Rudi' })
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ minLength: 8, maxLength: 200, format: 'password' })
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(200)
  password: string;

  @ApiPropertyOptional({ maxLength: 30, example: '+62 812 3456 789' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'rudi@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ format: 'password' })
  @IsNotEmpty()
  password: string;
}

/** Body of `POST /auth/refresh` — the opaque refresh token handed back at login. */
export class RefreshDto {
  @ApiProperty({ maxLength: 512, description: 'Refresh token from login/refresh (not the JWT access token)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  refresh_token: string;
}

/**
 * Body of `POST /auth/logout`. Both fields optional: `refresh_token` revokes a
 * single session, `all: true` revokes every session of the caller, and giving
 * neither also means "everything of mine" (a client that only kept the access
 * token can still log out).
 */
export class LogoutDto {
  @ApiPropertyOptional({ maxLength: 512, description: 'Revoke only this session' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  refresh_token?: string;

  @ApiPropertyOptional({ description: 'Revoke every session of the caller (default when neither field is given)' })
  @IsOptional()
  @IsBoolean()
  all?: boolean;
}
