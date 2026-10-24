import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto, LogoutDto, RefreshDto, RegisterDto } from './dto/auth.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { RateLimit } from '../common/rate-limit/rate-limit.decorator';

@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @RateLimit('auth')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @RateLimit('auth')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  /**
   * Mint a new session from a refresh token. Deliberately unauthenticated: the
   * refresh token *is* the credential, and this is what clients call once the
   * short-lived access token has expired.
   */
  @HttpCode(200)
  @Post('refresh')
  @RateLimit('auth')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refresh_token);
  }

  /** Requires a valid access token so only real session owners can revoke. */
  @HttpCode(200)
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  logout(@CurrentUser() user: any, @Body() dto: LogoutDto) {
    return this.auth.logout(user.sub, dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: any) {
    return this.auth.me(user);
  }
}
