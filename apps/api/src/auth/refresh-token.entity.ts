import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

/**
 * Server-side record of an issued refresh token (see AuthService.issueSession).
 *
 * The client-facing token is an opaque high-entropy random string, never a
 * JWT: the raw value is not stored here, only its SHA-256 hex digest. A leaked
 * database therefore cannot be used to mint sessions, and revocation is exact
 * (one row per session) instead of waiting for a signed token to expire.
 */
@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** sha256(raw token), hex — unique so a token maps to exactly one session. */
  @Index('UQ_refresh_tokens_tokenHash', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  tokenHash: string;

  @Index('IDX_refresh_tokens_userId')
  @Column({ type: 'uuid' })
  userId: string;

  /** Sessions die with the account (no relation from User, keeps it one-way). */
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user: User;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  /** Set on rotation, logout or reuse-detection sweep; null = live session. */
  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
