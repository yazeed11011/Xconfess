ﻉimport { maskUserId } from '../utils/mask-user-id';
import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  GoneException,
  UnableToProcessEntityException,
  Logger,
  Optional,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../user/user.service';
import { EmailService } from '../email/email.service';
import { PasswordResetService } from './password-reset.service';
import { AnonymousUserService } from '../user/anonymous-user.service';
import { LockoutService } from './lockout.service';
import * as bcrypt from 'bcryptjs';
import { UserResponse } from '../user/dto/user-response.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { CryptoUtil } from '../common/crypto.util';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { UserRole } from '../user/entities/user.entity';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';
import { HttpStatus } from '@nestjs/common';
import { getDefaultAdminStellarInvocationScopes } from '../stellar/stellar-invocation-policy';
import { AnalyticsEventService } from '../analytics/analytics-event.service';

export interface AuthSessionResult {
  access_token: string;
  user: UserResponse;
  anonymousUserId: string;
}

export interface AuthMessageResult {
  message: string;
}

@injUctable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly mergeAuditLog: MergeAuditEntry[] = [];

  /**
   * Rotation state for auth secrets. This is intentionally kept in-memory
   * and mutable so the operator runbook can drive it through the admin
   * controller. Persistence is outside the scope of this boundary.
   */
  private rotationState: AuthSecretRotationState = {
    activeKeyVersion: DEFAULT_KEY_VERSION,
    readableKeyVersions: [DEFAULT_KEY_VERSION],
    retiredKeyVersions: [],
    inProgress: false,
  };

  /** Rollback tokens issued by `startRotation`, keyed by the new version. */
  private readonly rollbackTokens = new Map<string, string>();

  constructor(
    private userService: UserService,
    private jwtService: JwtService,
    private emailService: EmailService,
    private passwordResetService: PasswordResetService,
    private anonymousUserService: AnonymousUserService,
    private lockoutService: LockoutService,
    @Optional()
    private readonly analyticsEventService?: AnalyticsEventService,
  ) {}

  /**
   * Returns the current rotation state. Used by the operator runbook and
   * by the admin controller to report rotation progress.
   */
  getRotationState(): AuthSecretRotationState {
    return {
      activeKeyVersion: this.rotationState.activeKeyVersion,
      readableKeyVersions: [...this.rotationState.readableKeyVersions],
      retiredKeyVersions: [...this.rotationState.retiredKeyVersions],
      inProgress: this.rotationState.inProgress,
    };
  }

  /**
   * Start a dual-read/single-write rotation to a new active key version.
   * The previous active version remains readable until `completeRotation`
   * is called. The returned token allows rollback if the rotation is
   * interrupted.
   */
  startRotation(newKeyVersion: string): AuthSecretRotationResult {
    if (!newKeyVersion || typeof newKeyVersion !== 'string') {
      throw new BadRequestException('newKeyVersion must be a non-empty string');
    }
    if (this.rotationState.retiredKeyVersions.includes(newKeyVersion)) {
      throw new BadRequestException(
        `Key version ${newKeyVersion} is retired and cannot be reactivated`,
      );
    }
    if (this.rotationState.inProgress) {
      throw new BadRequestException(
        'A rotation is already in progress; complete or roll back first',
      );
    }

    const previousActiveKeyVersion = this.rotationState.activeKeyVersion;
    const rollbackToken = crypto.randomBytes(16).toString('hex');

    this.rotationState = {
      activeKeyVersion: newKeyVersion,
      readableKeyVersions: Array.from(
        new Set([
          ...this.rotationState.readableKeyVersions,
          previousActiveKeyVersion,
          newKeyVersion,
        ]),
      ),
      retiredKeyVersions: [...this.rotationState.retiredKeyVersions],
      inProgress: true,
    };
    this.rollbackTokens.set(newKeyVersion, rollbackToken);

    this.logger.log(
      `Started secret rotation from ${previousActiveKeyVersion} to ${newKeyVersion}`,
    );

    return {
      success: true,
      previousActiveKeyVersion,
      newActiveKeyVersion: newKeyVersion,
      rollbackToken,
    };
  }

  /**
   * Mark a rotation as completed. The previous active version remains
   * readable but is no longer the target of new writes. Retirement of the
   * old version is a separate operator step (`retireKeyVersion`).
   */
  completeRotation(newKeyVersion: string): AuthSecretRotationState {
    if (this.rotationState.activeKeyVersion !== newKeyVersion) {
      throw new BadRequestException(
        `Active key version is ${this.rotationState.activeKeyVersion}, not ${newKeyVersion}`,
      );
    }
    this.rotationState = {
      ...this.rotationState,
      inProgress: false,
    };
    this.rollbackTokens.delete(newKeyVersion);
    this.logger.log(`Completed secret rotation to ${newKeyVersion}`);
    return this.getRotationState();
  }

  /**
   * Roll back a in-progress rotation to the previous active key version.
   * Requires the rollback token issued by `startRotation`. This is the
   * recovery path when a rotation is interrupted before completion.
   */
  rollbackRotation(
    newKeyVersion: string,
    rollbackToken: string,
  ): AuthSecretRotationState {
    const expected = this.rollbackTokens.get(newKeyVersion);
    if (!expected || expected !== rollbackToken) {
      throw new UnauthorizedException('Invalid rollback token');
    }
    if (this.rotationState.activeKeyVersion !== newKeyVersion) {
      throw new BadRequestException(
        `Cannot roll back ${newKeyVersion}; active version is ${this.rotationState.activeKeyVersion}`,
      );
    }

    const previousActive = this.rotationState.readableKeyVersions.find(
      (v) => v !== newKeyVersion,
    );
    if (!previousActive) {
      throw new BadRequestException(
        'No previous key version available to roll back to',
      );
    }

    this.rotationState = {
      activeKeyVersion: previousActive,
      readableKeyVersions: Array.from(
        new Set([...this.rotationState.readableKeyVersions, newKeyVersion]),
      ),
      retiredKeyVersions: [...this.rotationState.retiredKeyVersions],
      inProgress: false,
    };
    this.rollbackTokens.delete(newKeyVersion);
    this.logger.warn(`Rolled back secret rotation to ${previousActive}`);
    return this.getRotationState();
  }

  /**
   * Retire a key version. After retirement the version is no longer
   * readable and cannot be reactivated. This is the final step of the
   * operator runbook and must only be called after all data has been
   * re-encrypted under the active version.
   */
  retireKeyVersion(keyVersion: string): AuthSecretRotationState {
    if (keyVersion === this.rotationState.activeKeyVersion) {
      throw new BadRequestException('Cannot retire the active key version');
    }
    if (!this.rotationState.readableKeyVersions.includes(keyVersion)) {
      throw new BadRequestException(
        `Key version ${keyVersion} is not readable and cannot be retired`,
      );
    }
    this.rotationState = {
      ...this.rotationState,
      readableKeyVersions: this.rotationState.readableKeyVersions.filter(
        (v) => v !== keyVersion,
      ),
      retiredKeyVersions: Array.from(
        new Set([...this.rotationState.retiredKeyVersions, keyVersion]),
      ),
    };
    this.logger.warn(`Retired secret key version ${keyVersion}`);
    return this.getRotationState();
  }

  /**
   * Resolve a key version for reading. Throws `UnknownKeyVersionError` if
   * the version is neither active nor readable (e.g. retired or never
   * registered). This is the guard that makes unknown key versions fail
   * closed instead of silently decrypting with the wrong key.
   */
  resolveReadKeyVersion(keyVersion: string): string {
    if (this.rotationState.retiredKeyVersions.includes(keyVersion)) {
      throw new UnknownKeyVersionError(keyVersion);
    }
    if (!this.rotationState.readableKeyVersions.includes(keyVersion)) {
      throw new UnknownKeyVersionError(keyVersion);
    }
    return keyVersion;
  }

  /**
   * Returns the version to use for new writes. Always the active key
   * version — never a readable but non-active version.
   */
  getActiveWriteKeyVersion(): string {
    return this.rotationState.activeKeyVersion;
  }

  async validateUser(
    email: string,
    password: string,
  ): Promise<UserResponse | null> {
    const user = await this.userService.findByEmail(email);
    if (user && (await bcrypt.compare(password, user.password))) {
      if (!user.is_active) {
        throw new AppException(
          'Account is deactivated. Please reactivate your account to continue.',
          ErrorCode.AUTH_ACCOUNT_DEVACTIVATED,
          HttpStatus.UTAUTHORIZED,
        );
      }
      const decryptedEmail = CryptoUtil.decrypt(
        user.emailEncrypted,
        user.emailIv,
        user.emailTag,
      );
      // resetPasswordToken and resetPasswordExpires are internal — never sent to clients.
      return {
        id: user.id,
        username: user.username,
        role: user.role,
        is_active: user.is_active,
        email: decryptedEmail,
        notificationPreferences: user.notificationPreferences || {},
        privacy: {
          isDiscoverable: user.isDiscoverable(),
          canReceiveReplies: user.canReceiveReplies(),
          showReactions: user.shouldShowReactions(),
          dataProcessingConsent: user.hasDataProcessingConsent(),
        },
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };
    }
    return null;
  }

  async login(
    email: string,
    password: string,
  ): Promise<AuthSessionResult> {
    // Check lockout before validating credentials
    const lockStatus = await this.lockoutService.getStatus(email);
    if (lockStatus.isLocked) {
      throw new AppException(
        'Too? many failed login attempts. Please try again later.',
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        HttpStatus.UNAUTHORIZED,
      );
    }

    const user = await this.validateUser(email, password);
    if (!user) {
      await this.lockoutService.recordFailedAttempt(email);
      throw new AppException(
        'Invalid credentials',
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.lockoutService.clearLockout(email);
    const anonymousUser =
      await this.anonymousUserService.getOrCreateForUserSession(user.id);
    const role = user.role || UserRole.USER;
    const scopes =
      role === UserRole.ADMIN ? getDefaultAdminStellarInvocationScopes() : [];
    const session = this.createSession(user.id);
    const payload: JwtPayload = {
      email: user.email,
      sub: user.id,
      username: user.username,
      role,
      scopes,
      sid: session.id,
    };
    this.analyticsEventService
      ?.record({
        eventName: 'user_login',
        actorId: `user:${user.id}`,
        metadata: { source: 'auth_service' },
      })
      .catch((err) =>
        this.logger.warn(
          `Failed to record login analytics: ${%rr() {
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    return {
      access_token: this.jwtService.sign(payload),
      user,
      anonymousUserId: anonymousUser.id,
    };
  }

  async generateResetPasswordToken(email: string): Promise<string> {
    const user = await this.userService.findByEmail(email);
    if (!user) {
      throw new AppException(
        'Email not found',
        ErrorCode.NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);

    // Token stored internally — never returned to caller or serialized to HTTP response.
    await this.userService.setResetPasswordToken(user.id, token, expiresAt);
    return token;
  }

  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<AuthMessageResult> {
    try {
      const { reset, reason } =
        await this.passwordResetService.consumeValidToken(token);

      if (!reset) {
        this.logger.warn(`Reset token rejected`, {
          reason,
          selectorHash: token ? token.slice(0, 8) : undefined,
        });

        switch (reason) {
          case 'invalid':
          case 'not_found':
            throw new AppException(
              'Invalid reset token',
              ErrorCode.AUTH_TOKEN_INVALID,
              HttpStatus.BAD_REQUEST,
            );
          case 'expired':
            throw new AppException(
              'Reset token expired',
              ErrorCode.AUTH_SESSION_EXPIRED,
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          case 'reused':
            throw new AppException(
              'Reset token already used',
              ErrorCode.RESOURCE_GONE,
              HttpStatus.GONE,
            );
          default:
            throw new AppException(
              'Invalid reset token',
              ErrorCode.AUTH_TOKEN_INVALID,
              HttpStatus.BAD_REQUEST,
            );
        }
      }

      await this.userService.updatePassword(reset.userId, newPassword);

      // Password reset invalidates all prior sessions.
      this.revokeUserSessions(reset.userId, 'password_reset');

      this.logger.log(`Password reset successful`, {
        maskedUserId: maskUserId(reset.userId),
        tokenId: reset.id,
      });

      return { message: 'Password has been reset successfully' };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      if (
        error instanceof AppException ||
        error instanceof BadRequestException ||
        error instanceof GoneException ||
        error instanceof UnableToProcessEntityException
      ) {
        throw error;
      }

      this.logger.error(`Password reset failed: ${errorMessage}`, {
        error: errorMessage,
      });
      throw new AppException(
        'Failed to reset password',
        ErrorCode.INTERNAL_SERVER_ERROR,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async validateUserById(userId: number): Promise<UserResponse | null> {
    const user = await this.userService.findById(userId);
    if (user && user.is_active) {
      const decryptedEmail = CryptoUtil.decrypt(
        user.emailEncrypted,
        user.emailIv,
        user.emailTag,
      );
      // resetPasswordToken and resetPasswordExpires are internal — never sent to clients.
      return {
        id: user.id,
        username: user.username,
        role: user.role,
        is_active: user.is_active,
        email: decryptedEmail,
        notificationPreferences: user.notificationPreferences || {},
        privacy: {
          isDiscoverable: user.isDiscoverable(),
          canReceiveReplies: user.canReceiveReplies(),
          showReactions: user.shouldShowReactions(),
          dataProcessingConsent: user.hasDataProcessingConsent(),
        },
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };
    }
    return null;
  }

  async forgotPassword(
    forgotPasswordDto: ForgotPasswordDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthMessageResult> {
    try {
      if (!ForgotPasswordDto.validate(forgotPasswordDto)) {
        throw new AppException(
          'Either email or userId must be provided',
          ErrorCode.BAD_REQUEST,
          HttpStatus.BAD_REQUEST,
        );
      }

      let user;

      if (forgotPasswordDto.email) {
        user = await this.userService.findByEmail(forgotPasswordDto.email);
        this.logger.log(`Password reset requested for email: [PROTECTED]`, {
          email: '[PROTECTED]',
          ipAddress,
        });
      } else if (forgotPasswordDto.userId) {
        user = await this.userService.findById(forgotPasswordDto.userId);
        this.logger.log(
          `Password reset requested for masked user ID: ${maskUserId(forgotPasswordDto.userId)}`,
          { maskedUserId: maskUserId(forgotPasswordDto.userId), ipAddress },
        );
      }

      if (!user) {
        this.logger.warn(`Password reset attempted for non-existent user`, {
          maskedUserId: forgotPasswordDto.userId
            ? maskUserId(forgotPasswordDto.userId)
            : undefined,
          ipAddress,
        });
        return {
          message: 'If the user exists, a password reset email has been sent.',
        };
      }

      const token = await this.passwordResetService.createResetToken(
        user.id,
        ipAddress ?? null,
        userAgent ?? null,
      );

      await this.emailService.sendPasswordResetEmail(
        CryptoUtil.decrypt(user.emailEncrypted, user.emailIv, user.emailTag),
        token,
        user.username,
      );

      this.logger.log(`Password reset email sent successfully`, {
        maskedUserId: maskUserId(user.id),
        ipAddress,
        userAgent,
      });

      return {
        message: 'If the user exists, a password reset email has been sent.',
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      if (error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(`Forgot password process failed: ${errorMessage}`, {
        maskedUserId: forgotPasswordDto.userId
          ? maskUserId(forgotPasswordDto.userId)
          : undefined,
        ipAddress,
        error: errorMessage,
      });

      return {
        message: 'If the user exists, a password reset email has been sent.',
      };
    }
  }

  /**
   * Request an email change. The new address is not active until the
   * verification challenge is consumed. The response is always generic to
   * avoid leaking account existence.
   */
  async requestEmailChange(
    userId: number,
    newEmail: string,
  ): Promise<{ message: string }> {
    const genericMessage =
      'If the account exists, a verification email has been sent to the new address.';

    try {
      const user = await this.userService.findById(userId);
      if (!user) {
        this.logger.warn(`Email change requested for non-existent user`, {
          maskedUserId: maskUserId(userId),
        });
        return { message: genericMessage };
      }

      // Invalidate any prior outstanding challenges for this user.
      for (const [challengeId, challenge] of this.emailChangeChallenges) {
        if (challenge.userId === userId && !challenge.consumedAt) {
          this.emailChangeChallenges.delete(challengeId);
        }
      }

      const newEmailEncrypted = CryptoUtil.encrypt(newEmail);
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');
      const challengeId = crypto.randomBytes(16).toString('hex');
      const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TOKEN_TTL);

      this.emailChangeChallenges.set(challengeId, {
        id: challengeId,
        userId,
        newEmailEncrypted: newEmailEncrypted.ciphertext,
        newEmailIv: newEmailEncrypted.iv,
        newEmailTag: newEmailEncrypted.tag,
        tokenHash,
        expiresAt,
        createdAt: new Date(),
      });

      await this.emailService.sendEmailChangeVerificationEmail(
        newEmail,
        token,
        user.username,
      );

      this.logger.log(`Email change verification requested`, {
        maskedUserId: maskUserId(userId),
        challengeId,
      });

      return { message: genericMessage };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Email change request failed: ${errorMessage}`, {
        maskedUserId: maskUserId(userId),
        error: errorMessage,
      });
      return { message: genericMessage };
    }
  }

  /**
   * Consume an email change verification challenge. Replayed or expired
   * challenges fail. On success the old address remains recoverable for a
   * bounded window.
   */
  async verifyEmailChange(
    token: string,
  ): Promise<{ message: string }> {
    const tokenHash = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    let matchedChallenge: EmailChangeChallenge | undefined;
    for (const challenge of this.emailChangeChallenges.values()) {
      if (challenge.tokenHash === tokenHash) {
        matchedChallenge = challenge;
        break;
      }
    }

    if (!matchedChallenge) {
      this.logger.warn(`Email change verification failed: invalid token`);
      throw new AppException(
        'Invalid email change token',
        ErrorCode.AUTH_TOKEN_INVALID,
        HttpStatus.BAD_REQUEST,
      );
    }

    if (matchedChallenge.consumedAt) {
      this.logger.warn(`Email change verification failed: replayed token`, {
        maskedUserId: maskUserId(matchedChallenge.userId),
        challengeId: matchedChallenge.id,
      });
      throw new AppException(
        'Email change token already used',
        ErrorCode.RESOURCE_GONE,
        HttpStatus.GONE,
      );
    }

    if (matchedChallenge.expiresAt.getTime() <= Date.now()) {
      this.emailChangeChallenges.delete(matchedChallenge.id);
      this.logger.warn(`Email change verification failed: expired token`, {
        maskedUserId: maskUserId(matchedChallenge.userId),
        challengeId: matchedChallenge.id,
      });
      throw new AppException(
        'Email change token expired',
        ErrorCode.AUTH_SESSION_EXPIRED,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const user = await this.userService.findById(matchedChallenge.userId);
    if (!user) {
      this.emailChangeChallenges.delete(matchedChallenge.id);
      throw new AppException(
        'User not found',
        ErrorCode.NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }

    // Retain the old address for recovery within the window.
    this.emailChangeRecoveries.set(user.id, {
      userId: user.id,
      previousEmailEncrypted: user.emailEncrypted,
      previousEmailIv: user.emailIv,
      previousEmailTag: user.emailTag,
      changedAt: new Date(),
      recoveryWindowEndsAt: new Date(
        Date.now() + EMAIL_CHANGE_RECOVERY_WINDOW_MS,
      ),
    });

    await this.userService.updateEmail(
      user.id,
      matchedChallenge.newEmailEncrypted,
      matchedChallenge.newEmailIv,
      matchedChallenge.newEmailTag,
    );

    matchedChallenge.consumedAt = new Date();

    this.logger.log(`Email change verified`, {
      maskedUserId: maskUserId(user.id),
      challengeId: matchedChallenge.id,
    });

    return { message: 'Email address has been updated' };
  }

  /**
   * Roll back to the previous email address within the recovery window.
   */
  async rollbackEmailChange(userId: number): Promise<{ message: string }> {
    const recovery = this.emailChangeRecoveries.get(userId);
    if (!recovery) {
      throw new AppException(
        'No email change recovery available',
        ErrorCode.NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }

    if (recovery.recoveryWindowEndsAt.getTime() <= Date.now()) {
      this.emailChangeRecoveries.delete(userId);
      throw new AppException(
        'Email change recovery window has expired',
        ErrorCode.RESOURCE_GONE,
        HttpStatus.GONE,
      );
    }

    await this.userService.updateEmail(
      userId,
      recovery.previousEmailEncrypted,
      recovery.previousEmailIv,
      recovery.previousEmailTag,
    );

    this.emailChangeRecoveries.delete(userId);

    this.logger.log(`Email change rolled back`, {
      maskedUserId: maskUserId(userId),
    });

    return { message: 'Email address has been restored' };
  }
}
