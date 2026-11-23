import {
  ConflictException,
  GoneException,
  InternalServerErrorException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { performance } from 'node:perf_hooks';
import { Cron, CronExpression } from '@nestjs/schedule';
import { In, MoreThan, Repository } from 'typeorm';
import { ModerationAccessGrant } from '../entities/moderation-access-grant.entity';
import {
  ModerationPolicyRun,
  ModerationPolicyRunKind,
  ModerationPolicyRunStatus,
} from '../entities/moderation-policy-run.entity';
import { Report, ReportStatus, ReportType } from '../entities/report.entity';
import { User, UserRole } from '../../user/entities/user.entity';
import { ModerationService } from './moderation.service';
import { AuditActionType } from '../../audit-log/audit-log.entity';
import { SENSITIVE_REPORT_QUEUE_SCOPE } from '../entities/moderation-access-grant.entity';

const MAX_FIXTURES = 100;
const MAX_CLUSTER_REPORTS = 500;
const GRANT_MAX_HOURS = 24;
const PREVIEW_TTL_MINUTES = 10;
const ROLLBACK_TTL_HOURS = 24;
export const DEFAULT_MODERATION_QUEUE_SLA_SECONDS = 4 * 60 * 60;
export const DEFAULT_MODERATION_QUEUE_WARNING_SECONDS = 60 * 60;
export const DEFAULT_MODERATION_QUEUE_CRITICAL_SECONDS = 4 * 60 * 60;
export const MODERATION_QUEUE_METRIC_RETENTION_DAYS = 30;

function positiveSeconds(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

type PolicyAction = ReportStatus.RESOLVED | ReportStatus.DISMISSED;

interface PolicyRule {
  action: PolicyAction;
  explanation: string;
}

interface ReportSnapshot {
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
  action: PolicyAction;
  explanation: string;
}

interface CommittedReportSnapshot extends ReportSnapshot {
  applied: {
    status: ReportStatus;
    resolvedBy: number;
    resolvedAt: string;
    resolutionNotes: string;
    updatedAt: string;
  };
}

interface PreviewDetails {
  rules: Record<string, PolicyRule>;
  snapshots: ReportSnapshot[];
  committedSnapshots?: CommittedReportSnapshot[];
}

@Injectable()
export class ModerationGovernanceService {
  private readonly logger = new Logger(ModerationGovernanceService.name);

  constructor(
    @InjectRepository(ModerationAccessGrant)
    private readonly grantRepository: Repository<ModerationAccessGrant>,
    @InjectRepository(ModerationPolicyRun)
    private readonly policyRunRepository: Repository<ModerationPolicyRun>,
    @InjectRepository(Report)
    private readonly reportRepository: Repository<Report>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly moderationService: ModerationService,
  ) {}

  async grantQueueAccess(
    actorId: number,
    dto: { userId: number; reason: string; expiresAt: string },
    request?: Request,
  ): Promise<ModerationAccessGrant> {
    if (
      typeof dto.reason !== 'string' ||
      dto.reason.trim().length < 1 ||
      dto.reason.trim().length > 500
    ) {
      throw new UnprocessableEntityException(
        'Grant reason must contain between 1 and 500 characters',
      );
    }
    const expiresAt = new Date(dto.expiresAt);
    const now = new Date();
    const maxExpiry = new Date(
      now.getTime() + GRANT_MAX_HOURS * 60 * 60 * 1000,
    );
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= now ||
      expiresAt > maxExpiry
    ) {
      throw new UnprocessableEntityException(
        `Grant expiry must be in the future and no more than ${GRANT_MAX_HOURS} hours away`,
      );
    }
    if (dto.userId === actorId) {
      throw new UnprocessableEntityException(
        'Administrators cannot grant sensitive queue access to themselves',
      );
    }

    const target = await this.userRepository.findOne({
      where: { id: dto.userId },
      select: { id: true, role: true, is_active: true },
    });
    if (
      !target ||
      !target.is_active ||
      ![UserRole.ADMIN, UserRole.MODERATOR].includes(target.role)
    ) {
      throw new UnprocessableEntityException(
        'Access can only be granted to an active administrator or moderator',
      );
    }

    return this.grantRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(ModerationAccessGrant);
      const grant = await repository.save(
        repository.create({
          userId: dto.userId,
          grantedById: actorId,
          scope: SENSITIVE_REPORT_QUEUE_SCOPE,
          reason: dto.reason.trim(),
          expiresAt,
          revokedAt: null,
          revokedById: null,
        }),
      );
      await this.audit(
        actorId,
        AuditActionType.MODERATION_OVERRIDE,
        'moderation_access_grant',
        grant.id,
        {
          action: 'granted',
          userId: grant.userId,
          scope: grant.scope,
          expiresAt: grant.expiresAt.toISOString(),
          reason: grant.reason,
        },
        request,
        manager,
      );
      return grant;
    });
  }

  async listQueueAccessGrants(): Promise<ModerationAccessGrant[]> {
    return this.grantRepository.find({
      where: { scope: SENSITIVE_REPORT_QUEUE_SCOPE },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  async revokeQueueAccess(
    grantId: string,
    actorId: number,
    request?: Request,
  ): Promise<ModerationAccessGrant> {
    return this.grantRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(ModerationAccessGrant);
      const grant = await repository.findOne({
        where: { id: grantId, scope: SENSITIVE_REPORT_QUEUE_SCOPE },
        lock: { mode: 'pessimistic_write' },
      });
      if (!grant) throw new NotFoundException('Access grant not found');
      if (grant.revokedAt) {
        throw new ConflictException('Access grant has already been revoked');
      }

      grant.revokedAt = new Date();
      grant.revokedById = actorId;
      const saved = await repository.save(grant);
      await this.audit(
        actorId,
        AuditActionType.MODERATION_OVERRIDE,
        'moderation_access_grant',
        grant.id,
        { action: 'revoked', userId: grant.userId, scope: grant.scope },
        request,
        manager,
      );
      return saved;
    });
  }

  async findReportClusters(limit = 250): Promise<{
    clusters: Array<{
      confessionId: string;
      type: ReportType;
      reportIds: string[];
      count: number;
      firstReportedAt: Date;
      lastReportedAt: Date;
      signals: string[];
    }>;
    scanned: number;
  }> {
    const boundedLimit = Math.min(
      Math.max(Math.trunc(limit) || 250, 1),
      MAX_CLUSTER_REPORTS,
    );
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const reports = await this.reportRepository.find({
      where: {
        status: In([ReportStatus.PENDING, ReportStatus.REVIEWING]),
        createdAt: MoreThan(since),
      },
      select: {
        id: true,
        confessionId: true,
        type: true,
        createdAt: true,
      },
      order: { createdAt: 'DESC' },
      take: boundedLimit,
    });

    const groups = new Map<string, Report[]>();
    for (const report of reports) {
      const key = `${report.confessionId}:${report.type}`;
      const group = groups.get(key) ?? [];
      group.push(report);
      groups.set(key, group);
    }

    const clusters = [...groups.values()]
      .filter((group) => group.length > 1)
      .map((group) => ({
        confessionId: group[0].confessionId,
        type: group[0].type,
        reportIds: group.map(({ id }) => id),
        count: group.length,
        firstReportedAt: group[group.length - 1].createdAt,
        lastReportedAt: group[0].createdAt,
        signals: ['same confession', 'same report type'],
      }));

    return { clusters, scanned: reports.length };
  }

  async getReportQueueStats(): Promise<{
    pendingCount: number;
    oldestUnresolvedAgeSeconds: number | null;
    resolvedTodayCount: number;
    unresolvedCount: number;
    ageBuckets: {
      under15Minutes: number;
      under1Hour: number;
      under4Hours: number;
      over4Hours: number;
    };
    sla: {
      targetSeconds: number;
      attainedCount: number;
      breachedCount: number;
      attainmentPercent: number;
    };
    resolvedTodayWithinSlaCount: number;
    alertThresholds: {
      warningAgeSeconds: number;
      criticalAgeSeconds: number;
    };
    alertState: 'healthy' | 'warning' | 'critical';
    retention: {
      liveAggregateRetentionSeconds: number;
      policy: 'computed-on-demand';
    };
  }> {
    const warningAgeSeconds = positiveSeconds(
      process.env.MODERATION_QUEUE_WARNING_SECONDS,
      DEFAULT_MODERATION_QUEUE_WARNING_SECONDS,
    );
    const criticalAgeSeconds = positiveSeconds(
      process.env.MODERATION_QUEUE_SLA_SECONDS ??
        process.env.MODERATION_QUEUE_CRITICAL_SECONDS,
      DEFAULT_MODERATION_QUEUE_CRITICAL_SECONDS,
    );
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    try {
      const [
        pendingCount,
        unresolved,
        resolvedToday,
      ] = await Promise.all([
        this.reportRepository.count({
          where: { status: ReportStatus.PENDING },
        }),
        this.reportRepository.find({
          where: {
            status: In([ReportStatus.PENDING, ReportStatus.REVIEWING]),
          },
          select: { createdAt: true, status: true },
        }),
        this.reportRepository.find({
          where: {
            status: ReportStatus.RESOLVED,
            resolvedAt: MoreThan(today),
          },
          select: { createdAt: true, resolvedAt: true },
        }),
      ]);

      const now = Date.now();
      const ageBuckets = {
        under15Minutes: 0,
        under1Hour: 0,
        under4Hours: 0,
        over4Hours: 0,
      };
      let oldestUnresolvedAgeSeconds: number | null = null;
      let attainedCount = 0;

      for (const report of unresolved) {
        const ageSeconds = Math.max(
          0,
          Math.floor((now - report.createdAt.getTime()) / 1000),
        );
        oldestUnresolvedAgeSeconds =
          oldestUnresolvedAgeSeconds === null
            ? ageSeconds
            : Math.max(oldestUnresolvedAgeSeconds, ageSeconds);
        if (ageSeconds < 15 * 60) ageBuckets.under15Minutes++;
        else if (ageSeconds < 60 * 60) ageBuckets.under1Hour++;
        else if (ageSeconds < criticalAgeSeconds) ageBuckets.under4Hours++;
        else ageBuckets.over4Hours++;
        if (ageSeconds <= criticalAgeSeconds) attainedCount++;
      }

      const unresolvedCount = unresolved.length;
      const breachedCount = unresolvedCount - attainedCount;
      const resolvedTodayWithinSlaCount = resolvedToday.filter((report) => {
        if (!report.resolvedAt) return false;
        const resolutionSeconds = Math.max(
          0,
          Math.floor(
            (report.resolvedAt.getTime() - report.createdAt.getTime()) / 1000,
          ),
        );
        return resolutionSeconds <= criticalAgeSeconds;
      }).length;
      const alertState =
        oldestUnresolvedAgeSeconds !== null &&
        oldestUnresolvedAgeSeconds >= criticalAgeSeconds
          ? 'critical'
          : oldestUnresolvedAgeSeconds !== null &&
              oldestUnresolvedAgeSeconds >= warningAgeSeconds
            ? 'warning'
            : 'healthy';

      return {
        pendingCount,
        oldestUnresolvedAgeSeconds,
        resolvedTodayCount: resolvedToday.length,
        unresolvedCount,
        ageBuckets,
        sla: {
          targetSeconds: criticalAgeSeconds,
          attainedCount,
          breachedCount,
          attainmentPercent: unresolvedCount === 0
            ? 100
            : Math.round((attainedCount / unresolvedCount) * 10000) / 100,
        },
        resolvedTodayWithinSlaCount,
        alertThresholds: {
          warningAgeSeconds,
          criticalAgeSeconds,
        },
        alertState,
        retention: {
          liveAggregateRetentionSeconds: MODERATION_QUEUE_METRIC_RETENTION_DAYS * 24 * 60 * 60,
          policy: 'computed-on-demand',
        },
      };
    } catch (error: unknown) {
      throw new InternalServerErrorException(
        'Moderation queue metrics are temporarily unavailable',
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  async runShadowEvaluation(
    actorId: number,
    dto: {
      fixtures: Array<{ type: string; currentDecision: string }>;
      rules: Record<string, { action: string; explanation: string }>;
    },
    request?: Request,
  ): Promise<ModerationPolicyRun> {
    if (
      !Array.isArray(dto.fixtures) ||
      dto.fixtures.length < 1 ||
      dto.fixtures.length > MAX_FIXTURES
    ) {
      throw new UnprocessableEntityException(
        `Shadow evaluation requires between 1 and ${MAX_FIXTURES} fixtures`,
      );
    }
    const rules = this.validateRules(dto.rules);
    const start = performance.now();
    const byType: Record<string, { total: number; disagreements: number }> = {};
    let disagreements = 0;

    for (const fixture of dto.fixtures) {
      if (
        !fixture ||
        typeof fixture !== 'object' ||
        !Object.values(ReportType).includes(fixture.type as ReportType) ||
        !Object.values(ReportStatus).includes(
          fixture.currentDecision as ReportStatus,
        )
      ) {
        throw new UnprocessableEntityException(
          'Each fixture must have a valid report type and current decision',
        );
      }
      const proposed = rules[fixture.type]?.action ?? fixture.currentDecision;
      const disagrees = proposed !== fixture.currentDecision;
      const aggregate = byType[fixture.type] ?? {
        total: 0,
        disagreements: 0,
      };
      aggregate.total += 1;
      if (disagrees) {
        aggregate.disagreements += 1;
        disagreements += 1;
      }
      byType[fixture.type] = aggregate;
    }

    const latencyMs = Number((performance.now() - start).toFixed(3));
    const result = {
      fixtureCount: dto.fixtures.length,
      disagreements,
      disagreementRate: disagreements / dto.fixtures.length,
      latencyMs,
      averageLatencyMs: Number((latencyMs / dto.fixtures.length).toFixed(3)),
      byType,
    };

    const run = await this.policyRunRepository.manager.transaction(
      async (manager) => {
        const repository = manager.getRepository(ModerationPolicyRun);
        const saved = await repository.save(
          repository.create({
            createdById: actorId,
            kind: ModerationPolicyRunKind.SHADOW,
            status: ModerationPolicyRunStatus.COMPLETED,
            details: { rules },
            result,
            expiresAt: null,
            committedAt: null,
            rolledBackAt: null,
          }),
        );
        await this.audit(
          actorId,
          AuditActionType.MODERATION_OVERRIDE,
          'moderation_policy_run',
          saved.id,
          { action: 'shadow_evaluated', ...result },
          request,
          manager,
        );
        return saved;
      },
    );
    return run;
  }

  async previewPolicy(
    actorId: number,
    dto: {
      reportIds: string[];
      rules: Record<string, { action: string; explanation: string }>;
    },
    request?: Request,
  ): Promise<{
    previewId: string;
    expiresAt: Date;
    total: number;
    records: Array<{
      reportId: string;
      confessionId: string;
      type: ReportType;
      currentStatus: ReportStatus;
      proposedStatus: PolicyAction;
      explanation: string;
    }>;
  }> {
    const ids = this.validateReportIds(dto.reportIds);
    const rules = this.validateRules(dto.rules);

    const preview = await this.policyRunRepository.manager.transaction(
      async (manager) => {
        const reportRepository = manager.getRepository(Report);
        const reports = await reportRepository
          .createQueryBuilder('report')
          .where('report.id IN (:...ids)', { ids })
          .setLock('pessimistic_write')
          .getMany();
        if (reports.length !== ids.length) {
          throw new NotFoundException('One or more reports were not found');
        }

        const snapshots = reports.map((report): ReportSnapshot => {
          const rule = rules[report.type];
          if (!rule) {
            throw new UnprocessableEntityException(
              `No policy rule was provided for report type "${report.type}"`,
            );
          }
          if (
            ![ReportStatus.PENDING, ReportStatus.REVIEWING].includes(
              report.status,
            )
          ) {
            throw new ConflictException(
              `Report ${report.id} is no longer eligible for policy application`,
            );
          }
          return {
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
            action: rule.action,
            explanation: rule.explanation,
          };
        });
        const expiresAt = new Date(
          Date.now() + PREVIEW_TTL_MINUTES * 60 * 1000,
        );
        const repository = manager.getRepository(ModerationPolicyRun);
        const run = await repository.save(
          repository.create({
            createdById: actorId,
            kind: ModerationPolicyRunKind.PREVIEW,
            status: ModerationPolicyRunStatus.PENDING,
            details: { rules, snapshots },
            result: null,
            expiresAt,
            committedAt: null,
            rolledBackAt: null,
          }),
        );
        await this.audit(
          actorId,
          AuditActionType.MODERATION_OVERRIDE,
          'moderation_policy_run',
          run.id,
          { action: 'policy_previewed', reportCount: snapshots.length },
          request,
          manager,
        );
        return { run, snapshots };
      },
    );

    return {
      previewId: preview.run.id,
      expiresAt: preview.run.expiresAt!,
      total: preview.snapshots.length,
      records: preview.snapshots.map((snapshot) => ({
        reportId: snapshot.reportId,
        confessionId: snapshot.confessionId,
        type: snapshot.type,
        currentStatus: snapshot.previous.status,
        proposedStatus: snapshot.action,
        explanation: snapshot.explanation,
      })),
    };
  }

  async commitPolicyPreview(
    runId: string,
    actorId: number,
    request?: Request,
  ): Promise<{
    runId: string;
    status: ModerationPolicyRunStatus;
    applied: number;
  }> {
    let expired = false;
    const result = await this.policyRunRepository.manager.transaction(
      async (manager) => {
        const runs = manager.getRepository(ModerationPolicyRun);
        const run = await runs.findOne({
          where: { id: runId },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !run ||
          run.kind !== ModerationPolicyRunKind.PREVIEW ||
          run.createdById !== actorId
        ) {
          throw new NotFoundException('Policy preview not found');
        }
        if (run.status !== ModerationPolicyRunStatus.PENDING) {
          throw new ConflictException('Policy preview is no longer pending');
        }
        if (!run.expiresAt || run.expiresAt <= new Date()) {
          run.status = ModerationPolicyRunStatus.EXPIRED;
          await runs.save(run);
          expired = true;
          return { runId, status: run.status, applied: 0 };
        }

        const details = this.readPreviewDetails(run.details);
        const snapshots = details.snapshots;
        const reportRepository = manager.getRepository(Report);
        const reports = await reportRepository
          .createQueryBuilder('report')
          .where('report.id IN (:...ids)', {
            ids: snapshots.map(({ reportId }) => reportId),
          })
          .setLock('pessimistic_write')
          .getMany();
        if (reports.length !== snapshots.length) {
          throw new ConflictException(
            'The report set changed after this preview was created',
          );
        }

        const byId = new Map(reports.map((report) => [report.id, report]));
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
              `Report ${snapshot.reportId} changed after preview`,
            );
          }
          report.status = snapshot.action;
          report.resolvedBy = actorId;
          report.resolvedAt = new Date();
          report.resolutionNotes = snapshot.explanation;
        }

        const savedReports = await reportRepository.save(reports);
        const committedSnapshots: CommittedReportSnapshot[] = savedReports.map(
          (report) => {
            const snapshot = snapshots.find(
              (item) => item.reportId === report.id,
            )!;
            return {
              ...snapshot,
              applied: {
                status: report.status,
                resolvedBy: report.resolvedBy!,
                resolvedAt: report.resolvedAt!.toISOString(),
                resolutionNotes: report.resolutionNotes!,
                updatedAt: report.updatedAt.toISOString(),
              },
            };
          },
        );
        run.details = { ...details, committedSnapshots };
        run.status = ModerationPolicyRunStatus.COMMITTED;
        run.committedAt = new Date();
        await runs.save(run);
        await this.audit(
          actorId,
          AuditActionType.BULK_ACTION,
          'moderation_policy_run',
          run.id,
          {
            action: 'policy_committed',
            reportCount: snapshots.length,
            reportIds: snapshots.map(({ reportId }) => reportId),
            policyRules: details.rules,
          },
          request,
          manager,
        );
        return {
          runId,
          status: run.status,
          applied: savedReports.length,
        };
      },
    );

    if (expired) throw new GoneException('Policy preview has expired');
    return result;
  }

  async rollbackPolicy(
    runId: string,
    actorId: number,
    request?: Request,
  ): Promise<{
    runId: string;
    status: ModerationPolicyRunStatus;
    rolledBack: number;
  }> {
    const result = await this.policyRunRepository.manager.transaction(
      async (manager) => {
        const runs = manager.getRepository(ModerationPolicyRun);
        const run = await runs.findOne({
          where: { id: runId },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !run ||
          run.kind !== ModerationPolicyRunKind.PREVIEW ||
          run.createdById !== actorId
        ) {
          throw new NotFoundException('Policy operation not found');
        }
        if (run.status !== ModerationPolicyRunStatus.COMMITTED) {
          throw new ConflictException(
            'Only committed policy changes can roll back',
          );
        }
        const deadline =
          (run.committedAt?.getTime() ?? 0) +
          ROLLBACK_TTL_HOURS * 60 * 60 * 1000;
        if (deadline <= Date.now()) {
          throw new GoneException('Policy rollback window has expired');
        }

        const details = this.readPreviewDetails(run.details);
        const snapshots = details.committedSnapshots;
        if (!snapshots?.length) {
          throw new ConflictException('Committed report snapshot is missing');
        }
        const reportsRepository = manager.getRepository(Report);
        const reports = await reportsRepository
          .createQueryBuilder('report')
          .where('report.id IN (:...ids)', {
            ids: snapshots.map(({ reportId }) => reportId),
          })
          .setLock('pessimistic_write')
          .getMany();
        if (reports.length !== snapshots.length) {
          throw new ConflictException(
            'The report set changed after policy application',
          );
        }
        const byId = new Map(reports.map((report) => [report.id, report]));
        for (const snapshot of snapshots) {
          const report = byId.get(snapshot.reportId);
          if (
            !report ||
            report.status !== snapshot.applied.status ||
            report.resolvedBy !== snapshot.applied.resolvedBy ||
            report.resolvedAt?.toISOString() !== snapshot.applied.resolvedAt ||
            report.resolutionNotes !== snapshot.applied.resolutionNotes ||
            report.updatedAt.toISOString() !== snapshot.applied.updatedAt
          ) {
            throw new ConflictException(
              `Report ${snapshot.reportId} changed after policy application; rollback was not applied`,
            );
          }
          report.status = snapshot.previous.status;
          report.resolvedBy = snapshot.previous.resolvedBy;
          report.resolvedAt = snapshot.previous.resolvedAt
            ? new Date(snapshot.previous.resolvedAt)
            : null;
          report.resolutionNotes = snapshot.previous.resolutionNotes;
        }
        await reportsRepository.save(reports);
        run.status = ModerationPolicyRunStatus.ROLLED_BACK;
        run.rolledBackAt = new Date();
        run.details = {
          retained: false,
          reportCount: snapshots.length,
          rules: details.rules,
        };
        await runs.save(run);
        await this.audit(
          actorId,
          AuditActionType.BULK_ACTION,
          'moderation_policy_run',
          run.id,
          {
            action: 'policy_rolled_back',
            reportCount: snapshots.length,
            reportIds: snapshots.map(({ reportId }) => reportId),
            policyRules: details.rules,
          },
          request,
          manager,
        );
        return {
          runId,
          status: run.status,
          rolledBack: reports.length,
        };
      },
    );
    return result;
  }

  async getPolicyRun(
    runId: string,
    actorId: number,
  ): Promise<ModerationPolicyRun> {
    const run = await this.policyRunRepository.findOne({
      where: { id: runId, createdById: actorId },
    });
    if (!run) throw new NotFoundException('Policy run not found');
    return run;
  }

  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpiredGovernanceData(): Promise<void> {
    try {
      const now = new Date();
      const rollbackCutoff = new Date(
        now.getTime() - ROLLBACK_TTL_HOURS * 60 * 60 * 1000,
      );
      const retentionCutoff = new Date(
        now.getTime() - 90 * 24 * 60 * 60 * 1000,
      );
      const expiredPreviews = await this.policyRunRepository
        .createQueryBuilder()
        .update(ModerationPolicyRun)
        .set({
          status: ModerationPolicyRunStatus.EXPIRED,
          details: { retained: false },
          result: null,
        })
        .where(
          '"kind" = :kind AND "status" = :status AND "expires_at" <= :now',
          {
            kind: ModerationPolicyRunKind.PREVIEW,
            status: ModerationPolicyRunStatus.PENDING,
            now,
          },
        )
        .execute();
      const stalePreviews = await this.policyRunRepository
        .createQueryBuilder()
        .update(ModerationPolicyRun)
        .set({ details: { retained: false }, result: null })
        .where(
          '"kind" = :kind AND "status" = :status AND "committed_at" <= :cutoff',
          {
            kind: ModerationPolicyRunKind.PREVIEW,
            status: ModerationPolicyRunStatus.COMMITTED,
            cutoff: rollbackCutoff,
          },
        )
        .execute();
      const oldShadowRuns = await this.policyRunRepository
        .createQueryBuilder()
        .update(ModerationPolicyRun)
        .set({ details: { retained: false }, result: null })
        .where('"kind" = :kind AND "created_at" <= :cutoff', {
          kind: ModerationPolicyRunKind.SHADOW,
          cutoff: retentionCutoff,
        })
        .execute();
      const oldGrants = await this.grantRepository
        .createQueryBuilder()
        .delete()
        .from(ModerationAccessGrant)
        .where('"expires_at" <= :cutoff', { cutoff: retentionCutoff })
        .orWhere('"revoked_at" <= :cutoff', { cutoff: retentionCutoff })
        .execute();

      const purged =
        (expiredPreviews.affected ?? 0) +
        (stalePreviews.affected ?? 0) +
        (oldShadowRuns.affected ?? 0) +
        (oldGrants.affected ?? 0);
      if (purged > 0) {
        this.logger.log(
          `Purged expired moderation governance data (${purged} records)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to purge moderation governance data: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw error;
    }
  }

  private validateReportIds(value: string[]): string[] {
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > MAX_FIXTURES ||
      value.some((id) => typeof id !== 'string' || id.length === 0)
    ) {
      throw new UnprocessableEntityException(
        `Select between 1 and ${MAX_FIXTURES} reports`,
      );
    }
    const ids = [...new Set(value)];
    if (ids.length !== value.length) {
      throw new UnprocessableEntityException('Report IDs must be unique');
    }
    return ids;
  }

  private readPreviewDetails(value: Record<string, unknown>): PreviewDetails {
    if (!isRecord(value.rules) || !Array.isArray(value.snapshots)) {
      throw new InternalServerErrorException(
        'Stored moderation policy snapshot is invalid',
      );
    }

    const rules: Record<string, PolicyRule> = {};
    for (const [type, rule] of Object.entries(value.rules)) {
      if (!isPolicyRule(rule)) {
        throw new InternalServerErrorException(
          'Stored moderation policy rule is invalid',
        );
      }
      rules[type] = rule;
    }

    const snapshots: ReportSnapshot[] = [];
    for (const snapshot of value.snapshots) {
      if (!isReportSnapshot(snapshot)) {
        throw new InternalServerErrorException(
          'Stored moderation report snapshot is invalid',
        );
      }
      snapshots.push(snapshot);
    }

    let committedSnapshots: CommittedReportSnapshot[] | undefined;
    if (value.committedSnapshots !== undefined) {
      if (!Array.isArray(value.committedSnapshots)) {
        throw new InternalServerErrorException(
          'Stored committed report snapshot is invalid',
        );
      }
      committedSnapshots = [];
      for (const snapshot of value.committedSnapshots) {
        if (!isCommittedReportSnapshot(snapshot)) {
          throw new InternalServerErrorException(
            'Stored committed report snapshot is invalid',
          );
        }
        committedSnapshots.push(snapshot);
      }
    }

    return {
      rules,
      snapshots,
      ...(committedSnapshots ? { committedSnapshots } : {}),
    };
  }

  private validateRules(
    input: Record<string, { action: string; explanation: string }>,
  ): Record<string, PolicyRule> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new UnprocessableEntityException('Policy rules must be an object');
    }
    const validTypes = new Set<string>(Object.values(ReportType));
    const entries = Object.entries(input);
    if (!entries.length) {
      throw new UnprocessableEntityException(
        'At least one policy rule is required',
      );
    }

    const rules: Record<string, PolicyRule> = {};
    for (const [type, value] of entries) {
      if (
        !validTypes.has(type) ||
        !value ||
        typeof value !== 'object' ||
        ![ReportStatus.RESOLVED, ReportStatus.DISMISSED].includes(
          value.action as PolicyAction,
        ) ||
        typeof value.explanation !== 'string' ||
        value.explanation.trim().length < 1 ||
        value.explanation.trim().length > 500
      ) {
        throw new UnprocessableEntityException(
          `Invalid policy rule for report type "${type}"`,
        );
      }
      rules[type] = {
        action: value.action as PolicyAction,
        explanation: value.explanation.trim(),
      };
    }
    return rules;
  }

  private async audit(
    actorId: number,
    action: AuditActionType,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>,
    request: Request | undefined,
    manager: Parameters<ModerationService['logAction']>[7],
  ): Promise<void> {
    try {
      await this.moderationService.logAction(
        actorId,
        action,
        entityType,
        entityId,
        metadata,
        null,
        request,
        manager,
      );
    } catch (error) {
      this.logger.error(
        `Failed to persist moderation governance audit record: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPolicyRule(value: unknown): value is PolicyRule {
  return (
    isRecord(value) &&
    [ReportStatus.RESOLVED, ReportStatus.DISMISSED].includes(
      value.action as PolicyAction,
    ) &&
    typeof value.explanation === 'string'
  );
}

function isReportSnapshot(value: unknown): value is ReportSnapshot {
  if (!isRecord(value) || !isRecord(value.previous)) return false;
  const previous = value.previous;
  return (
    typeof value.reportId === 'string' &&
    typeof value.confessionId === 'string' &&
    Object.values(ReportType).includes(value.type as ReportType) &&
    Object.values(ReportStatus).includes(previous.status as ReportStatus) &&
    (previous.resolvedBy === null ||
      (typeof previous.resolvedBy === 'number' &&
        Number.isInteger(previous.resolvedBy))) &&
    (previous.resolvedAt === null || typeof previous.resolvedAt === 'string') &&
    (previous.resolutionNotes === null ||
      typeof previous.resolutionNotes === 'string') &&
    typeof previous.updatedAt === 'string' &&
    [ReportStatus.RESOLVED, ReportStatus.DISMISSED].includes(
      value.action as PolicyAction,
    ) &&
    typeof value.explanation === 'string'
  );
}

function isCommittedReportSnapshot(
  value: unknown,
): value is CommittedReportSnapshot {
  if (!isRecord(value)) return false;
  const applied = value.applied;
  if (!isRecord(applied) || !isReportSnapshot(value)) return false;
  return (
    [ReportStatus.RESOLVED, ReportStatus.DISMISSED].includes(
      applied.status as ReportStatus,
    ) &&
    typeof applied.resolvedBy === 'number' &&
    Number.isInteger(applied.resolvedBy) &&
    typeof applied.resolvedAt === 'string' &&
    typeof applied.resolutionNotes === 'string' &&
    typeof applied.updatedAt === 'string'
  );
}
