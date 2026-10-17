import { IsEmail, IsNotEmpty, IsOptional, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsNotEmpty()
  @MinLength(2)
  name: string;

  @IsNotEmpty()
  @MinLength(8)
  password: string;

  @IsOptional()
  phone?: string;

  @IsOptional()
  address?: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsNotEmpty()
  password: string;
}
