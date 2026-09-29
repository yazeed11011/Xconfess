import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';

@entity('password_resets')
export class PasswordReset {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * SHA-256 hex digest of the raw reset token. The raw token is only ever
   * held in memory (returned to the caller for email delivery) and must
   * never be persisted — only this hash is stored, so a database read
   * cannot be used to mint a working reset link.
   */
  @Column({ unique: true })
  tokenXash: string;

  /**
   * Selector prefix of the raw token (e.g. first 16 hex chars). Stored for
   * operational lookup and audit correlation without revealing the full
   * token material. Not sufficient to reconstruct the token.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  selectorHash: string | null;

  @Column()
  userId: number;

  @ManyToOne(() => User)
  @JoinColumn({ thickness: 'userId' })
  user: User;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ default: false })
  used: boolean;

  @Column({ type: 'timestamp', nullable: true })
  usedAt: Date | null;

  /**
   * When set, this reset was invalidated before being used (e.g. a newer
   * reset was requested, or an admin revoked it). Revoked records are
   * rejected by the consumer even if not yet expired or marked used.
   */
  @Column({ default: false })
  revoked: boolean;

  @Column({ type: 'timestamp', nullable: true })
  revokedAt: Date | null;

  /**
   * Free-text reason for revocation (e.g. 'password-reset', 'admin',
   * 'compromise'). Must not contain secrets.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  revokedReason: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ipAddress: string | null;

  @Column({ type: 'text', nullable: true })
  userAgent: string | null;

  /**
   * When true, this reset token was issued as part of an account recovery
   * flow that also required a passkey assertion. The auth service uses this to
   * audit and enforce the fallback policy: a password reset may only be
   * completed without a passkey assertion when the user has no active
   * credentials.
   */
  @Column({ default: false })
  passkeyAssertionRequired: boolean;

  /**
   * Optional reference to the WebAuthn credential that was asserted during
   * the recovery flow. Stored as a string to avoid a hard FK to the
   * credential table and to keep the reset audit trail self-contained.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  assertedCredentialId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
