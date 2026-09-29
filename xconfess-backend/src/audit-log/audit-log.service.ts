import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog, AuditActionType } from './audit-log.entity';
import { AuditLogRedactionService } from './audit-log-redaction.service';
import { AuditLogIntegrityService } from './audit-log-integrity.service';

export interface AuditLogContext {
  userId?: string | number | null;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
  actor?: AuditActor;
}

export type AuditActorType = 'admin' | 'user' | 'system' | 'webhook';

export interface AuditActor {
  type: AuditActorType;
  id: string;
  userId?: string | null;
  label?: string;
  source?: string | null;
}

export interface CreateAuditLogDto {
  actionType: AuditActionType;
  metadata?: Record<string, unknown>;
  context?: AuditLogContext;
}

export interface TemplateRolloutSourceMetadata {
  reason?: string;
  correlationId?: string;
  sourceEndpoint?: string;
  sourceMethod?: string;
}

export interface TemplateRolloutDiffRecord {
  templateKey: string;
  templateVersion?: string;
  changeType:
    | 'state_transition'
    | 'active_version_switch'
    | 'canary_update'
    | 'kill_switch_toggle'
    | 'fallback_activation';
  actorId: string;
  actorType?: AuditActorType;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  source?: TemplateRolloutSourceMetadata;
}

export type ExportLifecycleAction =
  | 'request_created'
  | 'generation_completed'
  | 'link_refreshed'
  | 'downloaded'
  | 'download_failed'
  | 'token_expired'
  | 'export_expired';

export type ExportActorType = AuditActorType;

export interface ExportLifecycleAuditRecord {
  action: ExportLifecycleAction;
  requestId: string;
  exportId?: string;
  actorType: ExportActorType;
  actorId?: string | null;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
  context?: AuditLogContext;
}

export type AccountMergeAction =
  | 'merge_requested'
  | 'merge_confirmed'
  | 'merge_completed'
  | 'merge_rolled_back'
  | 'merge_failed'
  | 'merge_conflict_detected'
  | 'merge_unauthorized';

export interface AccountMergeConflictRecord {
  entityType: 'username' | 'message' | 'draft' | 'tip' | 'anchor';
  entityId?: string;
  anonymousId?: string;
  authenticatedId?: string;
  resolution?: 'anonymous_wins' | 'authenticated_wins' | 'merged' | 'skipped';
  details?: Record<string, unknown>;
}

export interface AccountMergeAuditRecord {
  action: AccountMergeAction;
  mergeId: string;
  anonymousId: string;
  authenticatedId: string;
  authMethod?: string;
  confirmedAt?: string;
  completedAt?: string;
  conflicts?: AccountMergeConflictRecord[];
  transferred?: Record<string, number>;
  rollback?: Record<string, unknown>;
  reason?: string;
  metadata?: Record<string, unknown>;
  context?: AuditLogContext;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
    private readonly redaction: AuditLogRedactionService,
    private readonly integrity: AuditLogIntegrityService,
  ) {}

  private toNullableUserId(value?: string | number | null): number | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    const normalized =
      typeof value === 'number' ? value : Number.parseInt(value, 10);

    if (!Number.isInteger(normalized)) {
      return null;
    }

    return normalized;
  }

  private extractEntityId(metadata?: Record<string, any>): string | null {
    if (!metadata) {
      return null;
    }

    const candidates = [
      metadata.entityId,
      metadata.reportId,
      metadata.commentId,
      metadata.confessionId,
      metadata.exportId,
      metadata.requestId,
      metadata.mergeId,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate;
      }
    }

    return null;
  }

  private extractMetadataString(
    metadata: Record<string, unknown> | undefined,
    key: string,
  ): string | null {
    const value = metadata?.[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private createActor(
    type: AuditActorType,
    id: string,
    options?: { userId?: string | null; label?: string; source?: string | null },
  ): AuditActor {
    return {
      type,
      id,
      userId: options?.userId ?? null,
      ...(options?.label ? { label: options.label } : {}),
      ...(options?.source ? { source: options.source } : {}),
    };
  }

  private resolveActor(dto: CreateAuditLogDto): AuditActor | null {
    if (dto.context?.actor) {
      return dto.context.actor;
    }

    const userId = dto.context?.userId;
    if (userId === null || userId === undefined || userId === '') {
      return null;
    }

    return {
      type: 'user',
      id: String(userId),
      userId: String(userId),
    };
  }

  /**
   * Resolve the actor for a given audit log entry, falling back to the
   * context user id when no explicit actor is provided.
   */
  private resolveActor(dto: CreateAuditLogDto): AuditActor | null {
    if (dto.context?.actor) {
      return dto.context.actor;
    }

    const userId = dto.context?.userId;
    if (userId === null || userId === undefined || userId === '') {
      return null;
    }

    return this.createActor('user', String(userId));
  }

  /**
   * Build an audit actor descriptor. Keeps actor metadata consistent
   * across the various log helpers.
   */
  private createActor(
    type: AuditActorType,
    id: string,
    options: {
      userId?: string | null;
      label?: string;
      source?: string | null;
    } = {},
  ): AuditActor {
    return {
      type,
      id,
      userId: options.userId ?? null,
      ...(options.label ? { label: options.label } : {}),
      ...(options.source ? { source: options.source } : {}),
    };
  }

  /**
   * Log a sensitive action to the audit log
   * Includes error handling to prevent logging failures from breaking the application
   */
  async log(dto: CreateAuditLogDto): Promise<void> {
    try {
      const actor = this.resolveActor(dto);
      const templateKey = this.extractMetadataString(
        dto.metadata,
        'templateKey',
      );
      const templateVersion = this.extractMetadataString(
        dto.metadata,
        'templateVersion',
      );

      const rawMetadata = {
        ...(dto.metadata || {}),
        ...(actor
          ? {
              actorType: actor.type,
              actorId: actor.id,
              actorUserId: actor.userId || null,
              ...(actor.label ? { actorLabel: actor.label } : {}),
              ...(actor.source ? { actorSource: actor.source } : {}),
            }
          : {}),
        ...(dto.context?.requestId
          ? { requestId: dto.context.requestId }
          : {}),
        ...(templateKey && templateVersion
          ? {
              templateKey,
              templateVersion,
            }
          : {}),
      };

      let safeMetadata: Record<string, unknown> | null = rawMetadata;
      try {
        safeMetadata = this.redaction.redactMetadata(rawMetadata);
      } catch (redactionError: unknown) {
        this.logger.warn(
          `Audit metadata redaction failed, falling back to raw metadata: ${redactionError instanceof Error ? redactionError.message : 'unknown error'}`,
        );
      }

      const auditLog = this.auditLogRepository.create({
        adminId: this.toNullableUserId(dto.context?.userId || null),
        action: dto.actionType,
        entityType:
          typeof dto.metadata?.entityType === 'string'
            ? dto.metadata.entityType
            : null,
        entityId: this.extractEntityId(dto.metadata),
        metadata: safeMetadata,
        notes: null,
        ipAddress: dto.context?.ipAddress || null,
        userAgent: dto.context?.userAgent || null,
        requestId: dto.context?.requestId || null,
        integrityHash: null,
      });

      // Persist first to obtain the generated id and database-assigned createdAt
      const saved = await this.auditLogRepository.save(auditLog);

      // Compute HMAC integrity tag using the persisted values
      const integrityHash = this.integrity.computeIntegrityHash({
        id: saved.id,
        action: saved.action,
        adminId: saved.adminId,
        entityType: saved.entityType,
        entityId: saved.entityId,
        requestId: saved.requestId,
        ipAddress: saved.ipAddress,
        createdAt: saved.createdAt.toISOString(),
      });

      if (integrityHash) {
        await this.auditLogRepository.update(saved.id, { integrityHash });
      }

      this.logger.log(
        `Audit log created: ${dto.actionType} by ${actor?.type || 'anonymous'} ${this.redaction.maskIdentifier(actor?.id || dto.context?.userId || 'anonymous')}`,
      );
    } catch (error: unknown) {
      // Log the error but don't throw to prevent disrupting the main operation
      this.logger.error(
        `Failed to create audit log for action ${dto.actionType}: ${this.redaction.redactErrorMessage(error instanceof Error ? error.message : 'unknown error')}`,
        error instanceof Error ? this.redaction.redactErrorMessage(error.stack || '') : undefined,
      );
    }
  }

  /**
   * Log confession deletion
   */
  async logConfessionDelete(
    confessionId: string,
    userId: string,
    context?: AuditLogContext,
  ): Promise<void> {
    await this.log({
      actionType: AuditActionType.CONFESSION_DELETED,
      metadata: {
        confessionId,
        entityType: 'confession',
        entityId: confessionId,
        deletedAt: new Date().toISOString(),
      },
      context: { ...context, userId },
    });
  }

  /**
   * Log a moderation item's state transition (pending/flagged/escalated/
   * resolved/hidden/rejected), including actor, previous/next state, and reason.
   */
  async logModerationStateTransition(
    moderationLogId: string,
    from: string,
    to: string,
    actorId: string,
    reason: string,
    metadata?: { confessionId?: string; notes?: string },
    context?: AuditLogContext,
  ): Promise<void> {
    await this.log( {
      actionType: AuditActionType.MODERATION_STATE_TRANSITION,
      metadata: {
        entityType: 'moderation_log',
        entityId: moderationLogId,
        confessionId: metadata?.confessionId,
        previousState: from,
        nextState: to,
        reason,
        notes: metadata?.notes,
        transitionedAt: new Date().toISOString(),
      },
      context: {
        ...context,
        userId: actorId,
        actor: this.createActor('admin', actorId),
      },
    });
  }

  /**
   * Log comment deletion
   */
  async logCommentDelete(
    commentId: string,
    confessionId: string,
    userId: string,
    context?: AuditLogContext,
  ): Promise<void> {
    await this.log({
      actionType: AuditActionType.COMMENT_DELETED,
      metadata: {
        commentId,
        confessionId,
        entityType: 'comment',
        entityId: commentId,
        deletedAt: new Date().toISOString(),
      },
      context: { ...context, userId },
    });
  }

  /**
   * Log failed login attempt
   */
  async logFailedLogin(
    identifier: string,
    reason: string,
    context?: AuditLogContext,
  ): Promise<void> {
    await this.log({
      actionType: AuditActionType.FAILED_LOGIN,
      metadata: {
        identifier,
        reason,
        attemptedAt: new Date().toISOString(),
      },
      context,
    });
  }

  /**
   * Log report creation
   */
  async logReport(
    reportId: string,
    targetType: 'confession' | 'comment',
    targetId: string,
    reporterId: string,
    reason: string,
    context?: AuditLogContext,
  ): Promise<void> {
    await this.log( {
      actionType: AuditActionType.REPORT_CREATED,
      metadata: {
        reportId,
        targetType,
        targetId,
        entityType: targetType,
        entityId: targetId,
        reason,
        reportedAt: new Date().toISOString(),
      },
      context: { ...context, userId: reporterId },
    });
  }

  /**
   * Log report resolution
   */
  async logReportResolved(
    reportId: string,
    adminId: string,
    metadata: {
      previousStatus?: string;
      reason?: string;
      confessionId?: string;
      resolvedBy?: string;
    },
    context?: AuditLogContext,
  ): Promise<void> {
    await this.log({
      actionType: AuditActionType.REPORT_RESOLVED,
      metadata: {
        reportId,
        entityType: 'report',
        entityId: reportId,
        ...metadata,
        resolvedAt: new Date().toISOString(),
      },
      context: {
        ...context,
        userId: adminId,
        actor: this.createActor('admin', adminId),
      },
    });
  }

  /**
   * Log report dismissal
   */
  async logReportDismissed(
    reportId: string,
    adminId: string,
    metadata: {
      previousStatus?: string;
      reason?: string;
      confessionId?: string;
      dismissedBy?: string;
    },
    context?: AuditLogContext,
  ): Promise<void> {
    await this.log({
      actionType: AuditActionType.REPORT_DISMISSED,
      metadata: {
        reportId,
        entityType: 'report',
        entityId: reportId,
        ...metadata,
        dismissedAt: new Date().toISOString(),
      },
      context: {
        ...context,
        userId: adminId,
        actor: this.createActor('admin', adminId),
      },
    });
  }

  /**
   * Log notification DLQ replay actions performed by operators/admins.
   */
  async logNotificationDlqReplay(
    adminId: string,
    metadata: {
      replayType: 'single' | 'bulk';
      queue: string;
      operationId?: string;
      jobId?: string;
      targetJobIds?: string[];
      targetJobs?: Array<Record<string, unknown>>;
      filters?: Record<string, any>;
      summary?: {
        attempted: number;
        replayed: number;
        failed: number;
        deduplicated?: number;
        removed?: number;
        noOp?: boolean;
      };
      outcomes?: Array<Record<string, unknown>>;
      reason?: string | null;
      replayedAt?: string;
    },
    context?: AuditLogContext,
  ): Promise<void> {
    await this.log( {
      actionType: AuditActionType.NOTIFICATION_DLQ_REPLAY,
      metadata: {
        entityType: 'notification_dlq',
        ...metadata,
        replayedAt: metadata.replayedAt || new Date().toISOString(),
      },
      context: {
        ...context,
        userId: adminId,
        actor: this.createActor('admin', adminId),
      },
    });
  }

  /**
   * Log notification DLQ cleanup actions performed by operators/admins.
   */
  async logNotificationDlqCleanup(
    adminId: string,
    metadata: {
      cleanupType: 'bulk' | 'retention';
      queue: string;
      operationId?: string;
      targetJobIds?: string[];
      removedCount?: number;
      retainedCount?: number;
      cutoff?: string;
      reason?: string | null;
      cleanedAt?: string;
    },
    context?: AuditLogContext,
  ): Promise<void> {
    await this.log( {
      actionType: AuditActionType.NOTIFICATION_DLQ_CLEANUP,
      metadata: {
        entityType: 'notification_dlq',
        ...metadata,
        cleanedAt: metadata.cleanedAt || new Date().toISOString(),
      },
      context: {
        ...context,
        userId: adminId,
        actor: this.createActor('admin', adminId),
      },
    });
  }

  /**
   * Log an account merge / anonymous identity transfer event.
   *
   * This is the central audit entry point for the merge workflow. It captures:
   * - the actor (user or admin) that initiated the merge,
   * - the anonymous and authenticated identities involved,
   * - explicit confirmation evidence,
   * - conflicts that were surfaced and their resolutions,
   * - the count of entities transferred per category,
   * - rollback information when a merge is reversed.
   */
  async logAccountMerge(record: AccountMergeAuditRecord): Promise<void> {
    const actor =
      record.context?.actor ||
      this.createActor('user', record.authenticatedId, {
        userId: record.authenticatedId,
        source: 'account_merge',
      });

    const conflicts = (record.conflicts || []).map((conflict) => ({
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      anonymousId: conflict.anonymousId,
      authenticatedId: conflict.authenticatedId,
      resolution: conflict.resolution,
      details: conflict.details,
    }));

    await this.log({
      actionType: AuditActionType.ACCOUNT_MERGE,
      metadata: {
        entityType: 'account_merge',
        entityId: record.mergeId,
        mergeId: record.mergeId,
        mergeAction: record.action,
        anonymousId: record.anonymousId,
        authenticatedId: record.authenticatedId,
        authMethod: record.authMethod,
        confirmedAt: record.confirmedAt,
        completedAt: record.completedAt,
        conflictCount: conflicts.length,
        conflicts: conflicts.length > 0 ? conflicts : undefined,
        transferred: record.transferred,
        rollback: record.rollback,
        reason: record.reason,
        ...(record.metadata || {}),
        occurredAt: new Date().toISOString(),
      },
      context: {
        ...record.context,
        userId: record.authenticatedId,
        actor,
      },
      context: params.context,
    });
  }

  /**
   * Log a conflict detected during an account merge attempt.
   */
  async logAccountMergeConflict(
    mergeId: string,
    conflicts: AccountMergeConflictRecord[],
    context?: AuditLogContext,
  ): Promise<void> {
    await this.log({
      actionType: AuditActionType.ACCOUNT_MERGE_CONFLICT,
      metadata: {
        entityType: 'account_merge',
        entityId: mergeId,
        mergeId,
        conflictCount: conflicts.length,
        conflicts: conflicts.map((conflict) => ({
          entityType: conflict.entityType,
          entityId: conflict.entityId,
          anonymousId: conflict.anonymousId,
          authenticatedId: conflict.authenticatedId,
          resolution: conflict.resolution,
          details: conflict.details,
        })),
        detectedAt: new Date().toISOString(),
      },
      context,
    });
  }

  /**
   * Log an unauthorized merge attempt. This is a security-relevant event that
   * must be retained even when the merge itself is rejected.
   */
  async logAccountMergeUnauthorized(
    mergeId: string,
    attemptedButUnauthorizedId: string,
    reason: string,
    context?: AuditLogContext,
  ): Promise<void> {
    await this.log({
      actionType: AuditActionType.ACCOUNT_MERGE_UNAUTHORIZED,
      metadata: {
        entityType: 'account_merge',
        entityId: mergeId,
        mergeId,
        attemptedButUnauthorizedId,
        reason,
        attemptedAt: new Date().toISOString(),
      },
      context,
    });
  }

  /**
   * Log a rollback of a previously completed account merge.
   */
  async logAccountMergeRollback(
    mergeId: string,
    anonymousId: string,
    authenticatedId: string,
    rollback: Record<string, unknown>,
    reason: string,
    context?: AuditLogContext,
  ): Promise<void> {
    await this.log( {
      actionType: AuditActionType.ACCOUNT_MERGE_ROLLBACK,
      metadata: {
        entityType: 'account_merge',
        entityId: mergeId,
        mergeId,
        anonymousId: anonymousId,
        authenticatedId: authenticatedId,
        rollback,
        reason,
        rolledBackAt: new Date().toISOString(),
      },
      context: params.context,
    });
  }
}
