import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(200)
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsNotEmpty()
  password: string;
}

/** Body of `POST /auth/refresh` — the opaque refresh token handed back at login. */
export class RefreshDto {
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
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  refresh_token?: string;

  @IsOptional()
  @IsBoolean()
  all?: boolean;
}
