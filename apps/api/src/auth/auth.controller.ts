import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiError,
  LogoutResponse,
  SafeUserResponse,
  SessionResponse,
} from '../common/swagger-response-models';
import { AuthService } from './auth.service';
import { LoginDto, LogoutDto, RefreshDto, RegisterDto } from './dto/auth.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { RateLimit } from '../common/rate-limit/rate-limit.decorator';

@Controller('auth')
@UseGuards(RateLimitGuard)
@ApiTags('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @RateLimit('auth')
  @ApiOperation({ summary: 'Create a customer account', description: 'Rate-limited per IP. Returns access + refresh tokens and the user (password excluded).' })
  @ApiCreatedResponse({ type: SessionResponse, description: 'Nest default POST status. Token pair + the new user.' })
  @ApiError(400, 'Body failed validation — details carries the per-field messages.')
  @ApiError(409, 'Email already registered.')
  @ApiError(429, 'Auth rate limit exceeded; Retry-After header says when to retry.')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @RateLimit('auth')
  @ApiCreatedResponse({ type: SessionResponse, description: 'Nest default POST status. Token pair + the user.' })
  @ApiError(400, 'Body failed validation — details carries the per-field messages.')
  @ApiError(401, 'Invalid email or password (same answer for unknown email and wrong password — no existence leak).')
  @ApiError(429, 'Auth rate limit exceeded; Retry-After header says when to retry.')
  @ApiOperation({ summary: 'Exchange credentials for a token pair', description: 'Rate-limited per IP; wrong credentials answer 401 UNAUTHORIZED without saying which field was wrong.' })
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
  @ApiOperation({ summary: 'Rotate the session using a refresh token', description: 'Unauthenticated by design: the refresh token *is* the credential. The presented token is revoked and a fresh pair is issued.' })
  @ApiOkResponse({ type: SessionResponse })
  @ApiError(400, 'Body failed validation.')
  @ApiError(401, 'Unknown, expired or already-rotated refresh token — presenting a rotated one again revokes every session of the account (reuse detection).')
  @ApiError(429, 'Auth rate limit exceeded.')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refresh_token);
  }

  /** Requires a valid access token so only real session owners can revoke. */
  @HttpCode(200)
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke refresh session(s)', description: 'With `refresh_token`: that one session; with `all: true` or neither body field: every session of the caller.' })
  @ApiOkResponse({ type: LogoutResponse })
  @ApiError(401, 'Missing/invalid/expired access token.')
  logout(@CurrentUser() user: any, @Body() dto: LogoutDto) {
    return this.auth.logout(user.sub, dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Who am I — the JWT subject as a safe user object' })
  @ApiOkResponse({ type: SafeUserResponse })
  @ApiError(401, 'Missing/invalid/expired access token, or the account no longer exists.')
  me(@CurrentUser() user: any) {
    return this.auth.me(user);
  }
}
