import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { User } from '../users/user.entity';
import { RefreshToken } from './refresh-token.entity';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { toSafeUser } from '../common/safe-user';
import { durationToMs, expiryFrom } from '../common/duration';
import {
  ACCESS_TTL_DEFAULT,
  asTtl,
  REFRESH_TTL_DEFAULT,
  TOKEN_TYPE_ACCESS,
} from '../common/tokens';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(RefreshToken) private readonly sessions: Repository<RefreshToken>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private get accessTtl(): string {
    return this.config.get<string>('JWT_ACCESS_TTL') || ACCESS_TTL_DEFAULT;
  }

  private get refreshTtl(): string {
    return this.config.get<string>('JWT_REFRESH_TTL') || REFRESH_TTL_DEFAULT;
  }

  async register(dto: RegisterDto) {
    const existing = await this.users.findOne({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email already registered');
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = this.users.create({
      email: dto.email,
      name: dto.name,
      passwordHash,
      phone: dto.phone,
      address: dto.address,
    });
    await this.users.save(user);
    return this.issueSession(user);
  }

  async login(dto: LoginDto) {
    const user = await this.users.findOne({ where: { email: dto.email } });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      // 401 UNAUTHORIZED per standard semantics: presenting bad credentials is
      // an authentication failure, not a resource-state conflict. Same opaque
      // message for unknown email and wrong password — no existence leak.
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.issueSession(user);
  }

  /**
   * Exchange a refresh token for a fresh session. Rotation is mandatory: the
   * presented row is revoked here and a new one stored, so a token is usable
   * exactly once. A revoked row presented again means the token was copied —
   * every session of that user is then revoked (reuse detection).
   */
  async refresh(rawToken: string) {
    if (!rawToken) throw new UnauthorizedException('Missing refresh token');
    const session = await this.sessions.findOne({ where: { tokenHash: hashToken(rawToken) } });
    if (!session) throw new UnauthorizedException('Unknown refresh token');

    if (session.revokedAt) {
      const revoked = await this.revokeAllForUser(session.userId);
      throw new UnauthorizedException(
        `Refresh token reuse detected — ${revoked} session(s) revoked`,
      );
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.users.findOne({ where: { id: session.userId } });
    if (!user) {
      await this.revokeSession(session);
      throw new UnauthorizedException('Account no longer exists');
    }

    await this.revokeSession(session);
    return this.issueSession(user);
  }

  /**
   * `POST /auth/logout`, scoped to the authenticated caller: a token belonging
   * to another user is not matched and simply does nothing. Idempotent — an
   * unknown or already-revoked token still succeeds, because the caller's
   * intent (that session must not work any more) is satisfied either way.
   * Access tokens already issued stay valid until their short TTL runs out;
   * that is the point of `JWT_ACCESS_TTL` being minutes rather than days.
   */
  async logout(userId: string, dto: { refresh_token?: string; all?: boolean } = {}) {
    const revoked =
      dto.refresh_token && !dto.all
        ? await this.revokeForUserByToken(userId, dto.refresh_token)
        : await this.revokeAllForUser(userId);
    return { success: true, revoked_sessions: revoked };
  }

  /**
   * `GET /auth/me` — reads the profile from the database instead of echoing the
   * cached JWT claims, so a profile edit shows up immediately and a deleted
   * account stops answering with a token that has not expired yet.
   */
  async me(claims: { sub?: string } | undefined) {
    if (!claims?.sub) throw new UnauthorizedException('Missing subject claim');
    const user = await this.users.findOne({ where: { id: claims.sub } });
    if (!user) throw new UnauthorizedException('Account no longer exists');
    return toSafeUser(user);
  }

  /** Access JWT + stored opaque refresh token = one session. */
  private async issueSession(user: User) {
    const access_token = await this.jwt.signAsync(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
        typ: TOKEN_TYPE_ACCESS,
      },
      { expiresIn: asTtl(this.accessTtl) },
    );
    const rawToken = randomBytes(32).toString('base64url');
    const expiresAt = expiryFrom(Date.now(), this.refreshTtl);
    try {
      await this.sessions.save(
        this.sessions.create({ tokenHash: hashToken(rawToken), userId: user.id, expiresAt }),
      );
    } catch (err) {
      // A 256-bit random collision is not realistic, but the unique index would
      // surface it as an opaque 500 — turn it into a retryable 409.
      if (!isUniqueViolation(err)) throw err;
      throw new ConflictException('Could not issue session, please retry');
    }
    return {
      access_token,
      refresh_token: rawToken,
      token_type: 'Bearer',
      expires_in: durationToMs(this.accessTtl) / 1000,
      refresh_expires_at: expiresAt,
      user: toSafeUser(user),
    };
  }

  private async revokeSession(session: RefreshToken) {
    session.revokedAt = new Date();
    await this.sessions.save(session);
  }

  /** Revokes one session of `userId`, matched by the presented raw token. */
  private async revokeForUserByToken(userId: string, rawToken: string) {
    const result = await this.sessions.update(
      { userId, tokenHash: hashToken(rawToken), revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    return result.affected ?? 0;
  }

  /** Account-wide sweep — used by logout-all and by reuse detection. */
  private async revokeAllForUser(userId: string) {
    const result = await this.sessions.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    return result.affected ?? 0;
  }
}

/** Only the digest is ever persisted, so a leaked DB dump is not a session store. */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function isUniqueViolation(err: any): boolean {
  return err?.code === '23505' || /duplicate key value/i.test(String(err?.message ?? ''));
}
