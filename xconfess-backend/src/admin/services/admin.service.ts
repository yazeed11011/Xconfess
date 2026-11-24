import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  GoneException,
  Logger,
  Optional,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, In, Repository } from "typeorm";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Report, ReportStatus, ReportType } from "../entities/report.entity";
import { AnonymousConfession } from "../../confession/entities/confession.entity";
import { User, UserRole } from "../../user/entities/user.entity";
import { ModerationService } from "./moderation.service";
import { ModerationTemplateService } from "../../comment/moderation-template.service";
import { AuditActionType } from "../../audit-log/audit-log.entity";
import { Request } from "express";
import { decryptConfession } from "../../utils/confession-encryption";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { UserAnonymousUser } from "../../user/entities/user-anonymous-link.entity";
import { ConfigService } from "@nestjs/config";
import { Tip } from "../../tipping/entities/tip.entity";
import { AuditLogService } from "../../audit-log/audit-log.service";
import {
  SupportAccessPurpose,
  SupportAccessReviewDto,
  SupportAccessScope,
} from "../dto/support-access-review.dto";
import { JobManagementService } from "../../notifications/services/job-management.service";
import { LockoutService } from "../../auth/lockout.service";
import { SessionService } from "../../auth/session.service";
import { AdminGateway } from "../realtime/admin.gateway";
import { NotificationGateway } from "../../notifications/gateways/notification.gateway";
import {
  AdminActionApproval,
  AdminActionApprovalStatus,
  AdminCriticalAction,
} from "../entities/admin-action-approval.entity";
import {
  CursorPaginatedResponseDto,
  PAGINATION,
  decodeCursor,
  encodeCursor,
} from "../../common/pagination";
import { CacheService } from "../../cache/cache.service";
import {
  ModerationPolicyRun,
  ModerationPolicyRunKind,
  ModerationPolicyRunStatus,
} from "../entities/moderation-policy-run.entity";

export interface BulkResolveOutcome {
  id: string;
  outcome: "resolved" | "skipped" | "not_found";
  previousStatus?: ReportStatus;
}

export interface BulkResolveResult {
  requested: number;
  resolved: number;
  skipped: number;
  notFound: number;
  outcomes: BulkResolveOutcome[];
}

/** Issue #184 – snapshot stored inside a bulk-resolve preview run. */
interface BulkResolveSnapshot {
  reportId: string;
  confessionId: string;
  type: ReportType;
  previous: {
    status: ReportStatus;
    resolvedBy: number | null;
    resolvedAt: string | null;
    resolutionNotes: string | null;
    updatedAt: string;
  };
}

/** Issue #184 – what the commit endpoint returns. */
export interface BulkResolveCommitResult {
  previewId: string;
  status: ModerationPolicyRunStatus;
  applied: number;
  outcomes: Array<{
    reportId: string;
    outcome: "resolved" | "skipped";
  }>;
}

type UserSortField = "createdAt" | "username" | "role" | "status";
type SortOrder = "ASC" | "DESC";

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  private safeDecryptConfessionMessage(message: string): string {
    try {
      return decryptConfession(message, this.aesKey);
    } catch (e) {
      this.logger.warn(
        `Failed to decrypt confession message (returning raw). Reason: ${
          e instanceof Error ? e.message : "unknown"
        }`,
      );
      return message;
    }
  }

  constructor(
    @InjectRepository(Report)
    private readonly reportRepository: Repository<Report>,
    @InjectRepository(AnonymousConfession)
    private readonly confessionRepository: Repository<AnonymousConfession>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserAnonymousUser)
    private readonly userAnonRepository: Repository<UserAnonymousUser>,
    @InjectRepository(Tip)
    private readonly tipRepository: Repository<Tip>,
    private readonly moderationService: ModerationService,
    private readonly moderationTemplateService: ModerationTemplateService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly auditLogService: AuditLogService,
    private readonly jobManagementService: JobManagementService,
    private readonly lockoutService: LockoutService,
    private readonly sessionService: SessionService,
    @InjectRepository(AdminActionApproval)
    private readonly actionApprovalRepository: Repository<AdminActionApproval>,
    @InjectRepository(ModerationPolicyRun)
    private readonly policyRunRepository: Repository<ModerationPolicyRun>,
    private readonly cacheService: CacheService,
    @Optional()
    private readonly adminGateway?: AdminGateway,
    @Optional()
    private readonly notificationGateway?: NotificationGateway,
  ) {}

  private get aesKey(): string {
    return this.configService.get<string>("app.confessionAesKey", "");
  }

  private async runInModerationTransaction<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.reportRepository.manager.transaction(work);
  }

  private async invalidateConfessionCaches(id: string): Promise<void> {
    await Promise.all([
      this.cacheService.del(this.cacheService.buildKey("confession", id)),
      this.cacheService.invalidateSegment(
        "confessions",
        "confession moderation state changed",
      ),
    ]);
  }

  async reviewSupportAccess(
    userId: number,
    dto: SupportAccessReviewDto,
    adminId: number,
    request?: Request,
  ) {
    if (!Number.isSafeInteger(userId) || userId < 1) {
      throw new BadRequestException("A valid account ID is required.");
    }

    const validPurpose = Object.values(SupportAccessPurpose).includes(
      dto.purpose,
    );
    const validScope = Object.values(SupportAccessScope).includes(dto.scope);
    const requiredScope =
      dto.purpose === SupportAccessPurpose.ACCOUNT_RECOVERY
        ? SupportAccessScope.SECURITY_STATUS
        : SupportAccessScope.ACCOUNT_STATUS;
    const purposeMatchesScope =
      validPurpose && validScope && dto.scope === requiredScope;
    let user: User | null = null;
    let lookupFailed = false;
    let lookupError: unknown;
    if (purposeMatchesScope) {
      try {
        user = await this.userRepository.findOne({
          where: { id: userId },
          select: {
            id: true,
            username: true,
            role: true,
            is_active: true,
            totpEnabled: true,
          },
        });
      } catch (error) {
        lookupFailed = true;
        lookupError = error;
      }
    }

    const requestId = (request as (Request & { requestId?: string }) | undefined)
      ?.requestId;
    await this.auditLogService.logRequired({
      actionType: AuditActionType.ADMIN_SUPPORT_ACCESS_REVIEWED,
      metadata: {
        entityType: "support_access",
        entityId: String(userId),
        decision: user && !lookupFailed ? "allowed" : "denied",
        purpose: dto.purpose,
        scope: dto.scope,
        ...(lookupFailed ? { reason: "account_lookup_failed" } : {}),
        ...(!user && !lookupFailed ? { reason: "account_not_found" } : {}),
      },
      context: {
        userId: adminId,
        requestId,
        actor: { type: "admin", id: String(adminId), userId: String(adminId) },
      },
    });

    if (lookupFailed) {
      throw lookupError;
    }
    if (!purposeMatchesScope) {
      throw new ForbiddenException(
        "The requested support scope is not permitted for this purpose.",
      );
    }
    if (!user) {
      throw new NotFoundException("Account not found.");
    }

    const subject =
      dto.scope === SupportAccessScope.ACCOUNT_STATUS
        ? {
            id: user.id,
            username: user.username,
            role: user.role,
            isActive: user.is_active,
          }
        : {
            id: user.id,
            isActive: user.is_active,
            twoFactorEnabled: user.totpEnabled,
          };

    return {
      decision: "allowed" as const,
      purpose: dto.purpose,
      scope: dto.scope,
      subject,
    };
  }

  // Reports
  async getReports(
    status?: ReportStatus,
    type?: ReportType,
    startDate?: Date,
    endDate?: Date,
    limit = 50,
    offset = 0,
  ) {
    const query = this.reportRepository
      .createQueryBuilder("report")
      .leftJoinAndSelect("report.confession", "confession")
      .leftJoinAndSelect("report.reporter", "reporter")
      .leftJoinAndSelect("report.resolver", "resolver")
      .orderBy("report.createdAt", "DESC")
      .take(limit)
      .skip(offset);

    if (status) {
      query.andWhere("report.status = :status", { status });
    }

    if (type) {
      query.andWhere("report.type = :type", { type });
    }

    if (startDate) {
      query.andWhere("report.createdAt >= :startDate", { startDate });
    }

    if (endDate) {
      query.andWhere("report.createdAt <= :endDate", { endDate });
    }

    const [reports, total] = await query.getManyAndCount();
    const mapped = reports.map((r) => {
      if (r.confession?.message) {
        r.confession.message = this.safeDecryptConfessionMessage(
          r.confession.message,
        );
      }
      return r;
    });
    return [mapped, total] as const;
  }

  async getReportById(id: string): Promise<Report> {
    const report = await this.reportRepository.findOne({
      where: { id },
      relations: ["confession", "reporter", "resolver"],
    });

    if (!report) {
      throw new NotFoundException("Report not found");
    }

    if (report.confession?.message) {
      report.confession.message = this.safeDecryptConfessionMessage(
        report.confession.message,
      );
    }
    return report;
  }

  async resolveReport(
    id: string,
    adminId: number,
    resolutionNotes: string | null,
    templateId?: number | null,
    request?: Request,
  ): Promise<Report> {
    const templateUsed = templateId
      ? await this.moderationTemplateService
          .findById(templateId)
          .catch(() => null)
      : null;

    const saved = await this.runInModerationTransaction(async (manager) => {
      const reportRepo = manager.getRepository(Report);
      const report = await reportRepo.findOne({
        where: { id },
        lock: { mode: "pessimistic_write" },
      });

      if (!report) {
        throw new NotFoundException("Report not found");
      }

      if (
        report.status === ReportStatus.RESOLVED ||
        report.status === ReportStatus.DISMISSED
      ) {
        throw new BadRequestException(`Report is already ${report.status}`);
      }

      report.status = ReportStatus.RESOLVED;
      report.resolvedBy = adminId;
      report.resolvedAt = new Date();
      report.resolutionNotes = resolutionNotes;
      report.templateId = templateId ?? null;

      const updated = await reportRepo.save(report);

      await this.moderationService.logAction(
        adminId,
        AuditActionType.REPORT_RESOLVED,
        "report",
        id,
        {
          reportType: report.type,
          confessionId: report.confessionId,
          templateId,
          templateName: templateUsed?.name ?? null,
        },
        resolutionNotes,
        request,
        manager,
      );

      return updated;
    });

    this.eventEmitter.emit("report.updated", saved);

    return saved;
  }

  async dismissReport(
    id: string,
    adminId: number,
    notes: string | null,
    request?: Request,
  ): Promise<Report> {
    const saved = await this.runInModerationTransaction(async (manager) => {
      const reportRepo = manager.getRepository(Report);
      const report = await reportRepo.findOne({
        where: { id },
        lock: { mode: "pessimistic_write" },
      });

      if (!report) {
        throw new NotFoundException("Report not found");
      }

      if (
        report.status === ReportStatus.RESOLVED ||
        report.status === ReportStatus.DISMISSED
      ) {
        throw new BadRequestException(`Report is already ${report.status}`);
      }

      report.status = ReportStatus.DISMISSED;
      report.resolvedBy = adminId;
      report.resolvedAt = new Date();
      report.resolutionNotes = notes;

      const updated = await reportRepo.save(report);

      await this.moderationService.logAction(
        adminId,
        AuditActionType.REPORT_DISMISSED,
        "report",
        id,
        { reportType: report.type },
        notes,
        request,
        manager,
      );

      return updated;
    });

    this.eventEmitter.emit("report.updated", saved);

    return saved;
  }

  async bulkResolveReports(
    ids: string[],
    adminId: number,
    notes: string | null,
    request?: Request,
  ): Promise<BulkResolveResult> {
    const result = await this.runInModerationTransaction(async (manager) => {
      const reportRepo = manager.getRepository(Report);

      // Fetch all requested reports in one query (any status)
      const found = await reportRepo.find({
        where: { id: In(ids) },
      });

      const foundById = new Map(found.map((r) => [r.id, r]));

      const outcomes: BulkResolveOutcome[] = [];
      const toSave: Report[] = [];
      const now = new Date();

      for (const id of ids) {
        const report = foundById.get(id);

        if (!report) {
          outcomes.push({ id, outcome: "not_found" });
          continue;
        }

        if (
          report.status !== ReportStatus.PENDING &&
          report.status !== ReportStatus.REVIEWING
        ) {
          outcomes.push({
            id,
            outcome: "skipped",
            previousStatus: report.status,
          });
          continue;
        }

        const before = report.status;
        report.status = ReportStatus.RESOLVED;
        report.resolvedBy = adminId;
        report.resolvedAt = now;
        report.resolutionNotes = notes;
        toSave.push(report);
        outcomes.push({ id, outcome: "resolved", previousStatus: before });
      }

      if (toSave.length > 0) {
        await reportRepo.save(toSave);
      }

      // Write one audit entry per touched report so every ID is individually
      // attributable in the audit trail.
      for (const item of outcomes) {
        await this.moderationService.logAction(
          adminId,
          AuditActionType.BULK_ACTION,
          "report",
          item.id,
          {
            action: "bulk_resolve",
            outcome: item.outcome,
            previousStatus: item.previousStatus ?? null,
            resolvedAt: item.outcome === "resolved" ? now.toISOString() : null,
          },
          notes,
          request,
          manager,
        );
      }

      return {
        toPublish: toSave,
        summary: {
          requested: ids.length,
          resolved: outcomes.filter((o) => o.outcome === "resolved").length,
          skipped: outcomes.filter((o) => o.outcome === "skipped").length,
          notFound: outcomes.filter((o) => o.outcome === "not_found").length,
          outcomes,
        },
      };
    });

    if (result.toPublish.length > 0) {
      this.eventEmitter.emit("reports.bulk.updated", result.toPublish);
    }

    return result.summary;
  }

  /**
   * Issue #184 – Preview phase for bulk-resolve.
   *
   * Records the exact target set and consequences without altering any report.
   * Returns a previewId that the caller must present to commitBulkResolve.
   * The preview expires after 10 minutes.
   */
  async previewBulkResolve(
    ids: string[],
    adminId: number,
    notes: string | null,
    request?: Request,
  ): Promise<{
    previewId: string;
    expiresAt: Date;
    total: number;
    eligible: number;
    records: Array<{
      reportId: string;
      confessionId: string;
      type: ReportType;
      currentStatus: ReportStatus;
      wouldResolve: boolean;
    }>;
  }> {
    const PREVIEW_TTL_MINUTES = 10;

    const preview = await this.runInModerationTransaction(async (manager) => {
      const reportRepo = manager.getRepository(Report);

      const reports = await reportRepo
        .createQueryBuilder("report")
        .where("report.id IN (:...ids)", { ids })
        .setLock("pessimistic_write")
        .getMany();

      const foundIds = new Set(reports.map((r) => r.id));
      const missingIds = ids.filter((id) => !foundIds.has(id));
      if (missingIds.length > 0) {
        throw new NotFoundException(
          `Reports not found: ${missingIds.join(", ")}`,
        );
      }

      const snapshots: BulkResolveSnapshot[] = reports.map((report) => ({
        reportId: report.id,
        confessionId: report.confessionId,
        type: report.type,
        previous: {
          status: report.status,
          resolvedBy: report.resolvedBy,
          resolvedAt: report.resolvedAt?.toISOString() ?? null,
          resolutionNotes: report.resolutionNotes,
          updatedAt: report.updatedAt.toISOString(),
        },
      }));

      const expiresAt = new Date(Date.now() + PREVIEW_TTL_MINUTES * 60 * 1000);
      const policyRunRepo = manager.getRepository(ModerationPolicyRun);
      const run = await policyRunRepo.save(
        policyRunRepo.create({
          createdById: adminId,
          kind: ModerationPolicyRunKind.BULK_RESOLVE_PREVIEW,
          status: ModerationPolicyRunStatus.PENDING,
          details: { snapshots, notes: notes ?? null },
          result: null,
          expiresAt,
          committedAt: null,
          rolledBackAt: null,
        }),
      );

      await this.moderationService.logAction(
        adminId,
        AuditActionType.BULK_ACTION,
        "moderation_policy_run",
        run.id,
        {
          action: "bulk_resolve_previewed",
          reportIds: ids,
          reportCount: snapshots.length,
          notes: notes ?? null,
        },
        notes,
        request,
        manager,
      );

      return { run, snapshots };
    });

    const eligibleStatuses = new Set<ReportStatus>([
      ReportStatus.PENDING,
      ReportStatus.REVIEWING,
    ]);

    return {
      previewId: preview.run.id,
      expiresAt: preview.run.expiresAt!,
      total: preview.snapshots.length,
      eligible: preview.snapshots.filter((s) =>
        eligibleStatuses.has(s.previous.status),
      ).length,
      records: preview.snapshots.map((s) => ({
        reportId: s.reportId,
        confessionId: s.confessionId,
        type: s.type,
        currentStatus: s.previous.status,
        wouldResolve: eligibleStatuses.has(s.previous.status),
      })),
    };
  }

  /**
   * Issue #184 – Commit phase for bulk-resolve.
   *
   * Applies changes captured by previewBulkResolve.  The preview must still be
   * PENDING and unexpired; each report must be in exactly the same state as
   * when the preview was created.  Writes one per-report audit entry tied to
   * this preview.
   */
  async commitBulkResolve(
    previewId: string,
    adminId: number,
    request?: Request,
  ): Promise<BulkResolveCommitResult> {
    let expired = false;

    const result = await this.runInModerationTransaction(async (manager) => {
      const policyRunRepo = manager.getRepository(ModerationPolicyRun);
      const run = await policyRunRepo.findOne({
        where: { id: previewId },
        lock: { mode: "pessimistic_write" },
      });

      if (
        !run ||
        run.kind !== ModerationPolicyRunKind.BULK_RESOLVE_PREVIEW ||
        run.createdById !== adminId
      ) {
        throw new NotFoundException("Bulk-resolve preview not found");
      }
      if (run.status !== ModerationPolicyRunStatus.PENDING) {
        throw new ConflictException("Bulk-resolve preview is no longer pending");
      }
      if (!run.expiresAt || run.expiresAt <= new Date()) {
        run.status = ModerationPolicyRunStatus.EXPIRED;
        await policyRunRepo.save(run);
        expired = true;
        return {
          previewId,
          status: run.status,
          applied: 0,
          outcomes: [],
          toPublish: [] as Report[],
        };
      }

      const details = run.details as {
        snapshots: BulkResolveSnapshot[];
        notes: string | null;
      };
      const snapshots = details.snapshots;
      const notes = details.notes;

      const reportRepo = manager.getRepository(Report);
      const reports = await reportRepo
        .createQueryBuilder("report")
        .where("report.id IN (:...ids)", {
          ids: snapshots.map((s) => s.reportId),
        })
        .setLock("pessimistic_write")
        .getMany();

      if (reports.length !== snapshots.length) {
        throw new ConflictException(
          "The report set changed after this preview was created",
        );
      }

      const byId = new Map(reports.map((r) => [r.id, r]));
      for (const snapshot of snapshots) {
        const report = byId.get(snapshot.reportId);
        if (
          !report ||
          report.status !== snapshot.previous.status ||
          report.resolvedBy !== snapshot.previous.resolvedBy ||
          (report.resolvedAt?.toISOString() ?? null) !==
            snapshot.previous.resolvedAt ||
          report.resolutionNotes !== snapshot.previous.resolutionNotes ||
          report.updatedAt.toISOString() !== snapshot.previous.updatedAt
        ) {
          throw new ConflictException(
            `Report ${snapshot.reportId} changed after the preview was created`,
          );
        }
      }

      const eligibleStatuses = new Set<ReportStatus>([
        ReportStatus.PENDING,
        ReportStatus.REVIEWING,
      ]);

      const toSave: Report[] = [];
      const commitOutcomes: Array<{
        reportId: string;
        outcome: "resolved" | "skipped";
      }> = [];
      const now = new Date();

      for (const snapshot of snapshots) {
        const report = byId.get(snapshot.reportId)!;
        if (eligibleStatuses.has(report.status)) {
          report.status = ReportStatus.RESOLVED;
          report.resolvedBy = adminId;
          report.resolvedAt = now;
          report.resolutionNotes = notes;
          toSave.push(report);
          commitOutcomes.push({ reportId: snapshot.reportId, outcome: "resolved" });
        } else {
          commitOutcomes.push({ reportId: snapshot.reportId, outcome: "skipped" });
        }
      }

      if (toSave.length > 0) {
        await reportRepo.save(toSave);
      }

      // Per-report audit entries tied to the preview run.
      for (const outcome of commitOutcomes) {
        await this.moderationService.logAction(
          adminId,
          AuditActionType.BULK_ACTION,
          "report",
          outcome.reportId,
          {
            action: "bulk_resolve_committed",
            outcome: outcome.outcome,
            previewId,
            resolvedAt: outcome.outcome === "resolved" ? now.toISOString() : null,
          },
          notes,
          request,
          manager,
        );
      }

      run.status = ModerationPolicyRunStatus.COMMITTED;
      run.committedAt = now;
      run.result = {
        applied: toSave.length,
        outcomes: commitOutcomes,
      };
      await policyRunRepo.save(run);

      return {
        previewId,
        status: run.status,
        applied: toSave.length,
        outcomes: commitOutcomes,
        toPublish: toSave,
      };
    });

    if (expired) {
      throw new GoneException("Bulk-resolve preview has expired");
    }

    if (result.toPublish.length > 0) {
      this.eventEmitter.emit("reports.bulk.updated", result.toPublish);
    }

    return {
      previewId: result.previewId,
      status: result.status,
      applied: result.applied,
      outcomes: result.outcomes,
    };
  }

  // Confessions
  async requestAdminActionApproval(
    action: AdminCriticalAction,
    targetId: string,
    reason: string,
    adminId: number,
    request?: Request,
  ): Promise<AdminActionApproval> {
    if (action !== AdminCriticalAction.CONFESSION_DELETE) {
      throw new BadRequestException("Unsupported high-impact admin action");
    }
    const normalizedReason = reason?.trim();
    if (!normalizedReason || normalizedReason.length < 3) {
      throw new BadRequestException("A reason of at least 3 characters is required");
    }

    return this.actionApprovalRepository.manager.transaction(async (manager) => {
      const approvalRepo = manager.getRepository(AdminActionApproval);
      const confessionRepo = manager.getRepository(AnonymousConfession);
      const confession = await confessionRepo.findOne({
        where: { id: targetId },
      });

      if (!confession) {
        throw new NotFoundException("Confession not found");
      }
      if (confession.isDeleted) {
        throw new ConflictException("Confession is already deleted");
      }

      const requestedAt = new Date();
      const expiresAt = new Date(
        requestedAt.getTime() + this.approvalTtlMinutes * 60_000,
      );
      const approval = await approvalRepo.save(
        approvalRepo.create({
          action,
          targetId,
          requestedById: adminId,
          approvedById: null,
          status: AdminActionApprovalStatus.PENDING,
          reason: normalizedReason,
          cancellationReason: null,
          expiresAt,
          approvedAt: null,
          executedAt: null,
          cancelledAt: null,
          expiredAt: null,
        }),
      );

      await this.moderationService.logAction(
        adminId,
        AuditActionType.BULK_ACTION,
        "admin_action_approval",
        approval.id,
        {
          event: "requested",
          action,
          targetId,
          expiresAt: expiresAt.toISOString(),
        },
        normalizedReason,
        request,
        manager,
      );
      return approval;
    });
  }

  async findPendingAdminActionApprovals(): Promise<AdminActionApproval[]> {
    return this.actionApprovalRepository.find({
      where: { status: AdminActionApprovalStatus.PENDING },
      order: { requestedAt: "ASC" },
      take: 100,
    });
  }

  async approveAdminAction(
    approvalId: string,
    adminId: number,
    request?: Request,
  ): Promise<AdminActionApproval> {
    const outcome = await this.actionApprovalRepository.manager.transaction(
      async (manager) => {
        const approvalRepo = manager.getRepository(AdminActionApproval);
        const approval = await approvalRepo.findOne({
          where: { id: approvalId },
          lock: { mode: "pessimistic_write" },
        });
        if (!approval) {
          throw new NotFoundException("Action approval not found");
        }
        if (approval.status !== AdminActionApprovalStatus.PENDING) {
          throw new ConflictException("Action approval is no longer pending");
        }
        if (approval.requestedById === adminId) {
          throw new ForbiddenException(
            "A different administrator must approve this action",
          );
        }

        const now = new Date();
        if (approval.expiresAt.getTime() <= now.getTime()) {
          approval.status = AdminActionApprovalStatus.EXPIRED;
          approval.expiredAt = now;
          await approvalRepo.save(approval);
          await this.logApprovalLifecycle(
            manager,
            approval,
            null,
            "expired",
          );
          return { approval, expired: true };
        }

        if (approval.action !== AdminCriticalAction.CONFESSION_DELETE) {
          throw new ConflictException("Unsupported high-impact admin action");
        }
        const confessionRepo = manager.getRepository(AnonymousConfession);
        const confession = await confessionRepo.findOne({
          where: { id: approval.targetId },
          lock: { mode: "pessimistic_write" },
        });
        if (!confession) {
          throw new NotFoundException("Confession not found");
        }
        if (confession.isDeleted) {
          throw new ConflictException("Confession is already deleted");
        }

        approval.approvedById = adminId;
        approval.approvedAt = now;
        approval.executedAt = now;
        approval.status = AdminActionApprovalStatus.EXECUTED;
        confession.isDeleted = true;
        await confessionRepo.save(confession);
        await approvalRepo.save(approval);
        await this.logApprovalLifecycle(
          manager,
          approval,
          adminId,
          "approved",
          request,
        );
        await this.logApprovalLifecycle(
          manager,
          approval,
          adminId,
          "executed",
          request,
        );
        return { approval, expired: false };
      },
    );

    if (outcome.expired) {
      throw new GoneException("Action approval has expired");
    }
    await this.invalidateConfessionCaches(outcome.approval.targetId);
    return outcome.approval;
  }

  async cancelAdminActionApproval(
    approvalId: string,
    adminId: number,
    reason?: string,
    request?: Request,
  ): Promise<AdminActionApproval> {
    const outcome = await this.actionApprovalRepository.manager.transaction(
      async (manager) => {
        const approvalRepo = manager.getRepository(AdminActionApproval);
        const approval = await approvalRepo.findOne({
          where: { id: approvalId },
          lock: { mode: "pessimistic_write" },
        });
        if (!approval) {
          throw new NotFoundException("Action approval not found");
        }
        if (approval.requestedById !== adminId) {
          throw new ForbiddenException(
            "Only the requesting administrator can cancel this action",
          );
        }
        if (approval.status !== AdminActionApprovalStatus.PENDING) {
          throw new ConflictException("Action approval is no longer pending");
        }

        const now = new Date();
        if (approval.expiresAt.getTime() <= now.getTime()) {
          approval.status = AdminActionApprovalStatus.EXPIRED;
          approval.expiredAt = now;
          await approvalRepo.save(approval);
          await this.logApprovalLifecycle(
            manager,
            approval,
            null,
            "expired",
          );
          return { approval, expired: true };
        }

        approval.status = AdminActionApprovalStatus.CANCELLED;
        approval.cancelledAt = now;
        approval.cancellationReason = reason?.trim() || null;
        await approvalRepo.save(approval);
        await this.logApprovalLifecycle(
          manager,
          approval,
          adminId,
          "cancelled",
          request,
          approval.cancellationReason,
        );
        return { approval, expired: false };
      },
    );

    if (outcome.expired) {
      throw new GoneException("Action approval has expired");
    }
    return outcome.approval;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async expirePendingAdminActionApprovals(): Promise<number> {
    return this.actionApprovalRepository.manager.transaction(async (manager) => {
      const approvalRepo = manager.getRepository(AdminActionApproval);
      const expiredApprovals = await approvalRepo
        .createQueryBuilder("approval")
        .where("approval.status = :status", {
          status: AdminActionApprovalStatus.PENDING,
        })
        .andWhere("approval.expires_at <= :now", { now: new Date() })
        .orderBy("approval.expires_at", "ASC")
        .setLock("pessimistic_write")
        .setOnLocked("skip_locked")
        .take(100)
        .getMany();

      for (const approval of expiredApprovals) {
        approval.status = AdminActionApprovalStatus.EXPIRED;
        approval.expiredAt = new Date();
        await approvalRepo.save(approval);
        await this.logApprovalLifecycle(manager, approval, null, "expired");
      }
      return expiredApprovals.length;
    });
  }

  private get approvalTtlMinutes(): number {
    return (
      this.configService.get<number>("ADMIN_ACTION_APPROVAL_TTL_MINUTES") ?? 30
    );
  }

  private async logApprovalLifecycle(
    manager: EntityManager,
    approval: AdminActionApproval,
    actorId: number | null,
    event: "approved" | "executed" | "cancelled" | "expired",
    request?: Request,
    cancellationReason?: string | null,
  ): Promise<void> {
    await this.moderationService.logAction(
      actorId,
      AuditActionType.BULK_ACTION,
      "admin_action_approval",
      approval.id,
      {
        event,
        action: approval.action,
        targetId: approval.targetId,
        requestedById: approval.requestedById,
        approvedById: approval.approvedById,
        ...(cancellationReason ? { cancellationReason } : {}),
      },
      approval.reason,
      request,
      manager,
    );
  }

  async hideConfession(
    id: string,
    adminId: number,
    reason: string | null,
    request?: Request,
  ): Promise<AnonymousConfession> {
    const saved = await this.runInModerationTransaction(async (manager) => {
      const confessionRepo = manager.getRepository(AnonymousConfession);
      const confession = await confessionRepo.findOne({
        where: { id },
      });

      if (!confession) {
        throw new NotFoundException("Confession not found");
      }
      if (confession.isHidden) {
        throw new ConflictException("Confession is already hidden");
      }

      confession.isHidden = true;
      const saved = await confessionRepo.save(confession);

      await this.moderationService.logAction(
        adminId,
        AuditActionType.CONFESSION_HIDDEN,
        "confession",
        id,
        { reason },
        reason,
        request,
        manager,
      );

      return saved;
    });
    await this.invalidateConfessionCaches(id);
    return saved;
  }

  async unhideConfession(
    id: string,
    adminId: number,
    request?: Request,
  ): Promise<AnonymousConfession> {
    const saved = await this.runInModerationTransaction(async (manager) => {
      const confessionRepo = manager.getRepository(AnonymousConfession);
      const confession = await confessionRepo.findOne({
        where: { id },
      });

      if (!confession) {
        throw new NotFoundException("Confession not found");
      }
      if (confession.isDeleted) {
        throw new ConflictException("Deleted confessions cannot be restored");
      }
      if (!confession.isHidden) {
        throw new ConflictException("Confession is not hidden");
      }

      confession.isHidden = false;
      const saved = await confessionRepo.save(confession);

      await this.moderationService.logAction(
        adminId,
        AuditActionType.CONFESSION_UNHIDDEN,
        "confession",
        id,
        {},
        null,
        request,
        manager,
      );

      return saved;
    });
    await this.invalidateConfessionCaches(id);
    return saved;
  }

  // Session rotation / revocation (admin-safe)
  async revokeUserSessions(
    userId: number,
    adminId: number,
    reason: string,
    request?: Request,
  ): Promise<{ revoked: number }> {
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException("Reason is required for session revocation");
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException("User not found");
    }

    const revoked = await this.sessionService.revokeAllForUser(userId, {
      reason: "admin_revocation",
      adminId,
    });

    await this.notificationGateway?.revokeUserSessions(
      String(userId),
      "SESSION_REVOKED",
    );
    this.adminGateway?.revokeUserSessions(userId, "SESSION_REVOKED");

    await this.moderationService.logAction(
      adminId,
      AuditActionType.USER_SESSIONS_REVOKED,
      "user",
      String(userId),
      {
        reason,
        revokedCount: revoked,
      },
      reason,
      request,
    );

    return { revoked };
  }

  async rotateUserSessions(
    userId: number,
    adminId: number,
    reason: string,
    request?: Request,
  ): Promise<{ rotated: number }> {
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException("Reason is required for session rotation");
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException("User not found");
    }

    const rotated = await this.sessionService.rotateAllForUser(userId, {
      reason: "admin_rotation",
      adminId,
    });

    await this.moderationService.logAction(
      adminId,
      AuditActionType.USER_SESSIONS_ROTATED,
      "user",
      String(userId),
      {
        reason,
        rotatedCount: rotated,
      },
      reason,
      request,
    );

    return { rotated };
  }

  async listUserSessions(userId: number): Promise<{
    id: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date;
    revoked: boolean;
  }[]> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException("User not found");
    }

    const sessions = await this.sessionService.listForUser(userId);
    return sessions.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt ?? null,
      expiresAt: s.expiresAt,
      revoked: s.revokedAt != null,
    }));
  }
}
