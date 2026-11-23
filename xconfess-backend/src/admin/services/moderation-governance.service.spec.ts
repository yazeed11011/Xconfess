import {
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { ModerationAccessGrant } from '../entities/moderation-access-grant.entity';
import { ModerationPolicyRun } from '../entities/moderation-policy-run.entity';
import { Report, ReportStatus, ReportType } from '../entities/report.entity';
import { User } from '../../user/entities/user.entity';
import { ModerationGovernanceService } from './moderation-governance.service';
import { ModerationService } from './moderation.service';

describe('ModerationGovernanceService', () => {
  const audit = { logAction: jest.fn().mockResolvedValue({}) };

  function makeService(reportRows: Report[] = []) {
    const reportRepository = {
      find: jest.fn().mockResolvedValue(reportRows),
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
    };
    const policyRunRows: ModerationPolicyRun[] = [];
    const policyRunRepository: Record<string, unknown> = {
      manager: {
        transaction: jest.fn(async (callback: (manager: unknown) => unknown) =>
          callback({
            getRepository: () => ({
              create: (record: unknown) => record,
              save: jest.fn(async (record: Record<string, unknown>) => {
                const saved = { id: 'run-1', ...record } as ModerationPolicyRun;
                policyRunRows.push(saved);
                return saved;
              }),
            }),
          }),
        ),
      },
    };

    return {
      service: new ModerationGovernanceService(
        {} as never as Repository<ModerationAccessGrant>,
        policyRunRepository as unknown as Repository<ModerationPolicyRun>,
        reportRepository as unknown as Repository<Report>,
        {} as never as Repository<User>,
        audit as never as ModerationService,
      ),
      reportRepository,
      policyRunRows,
    };
  }

  beforeEach(() => jest.clearAllMocks());

  it('returns privacy-safe queue aging and SLA aggregates', async () => {
    process.env.MODERATION_QUEUE_SLA_SECONDS = '14400';
    const now = Date.now();
    const { service, reportRepository } = makeService();
    reportRepository.find
      .mockResolvedValueOnce([
        { createdAt: new Date(now - 5 * 60 * 1000), status: ReportStatus.PENDING },
        { createdAt: new Date(now - 30 * 60 * 1000), status: ReportStatus.REVIEWING },
        { createdAt: new Date(now - 5 * 60 * 60 * 1000), status: ReportStatus.PENDING },
      ] as unknown as Report[])
      .mockResolvedValueOnce([
        {
          createdAt: new Date(now - 2 * 60 * 60 * 1000),
          resolvedAt: new Date(now - 30 * 60 * 1000),
        },
        {
          createdAt: new Date(now - 8 * 60 * 60 * 1000),
          resolvedAt: new Date(now - 30 * 60 * 1000),
        },
      ] as unknown as Report[]);
    reportRepository.count.mockResolvedValueOnce(2);

    const result = await service.getReportQueueStats();

    expect(result).toEqual(expect.objectContaining({
      pendingCount: 2,
      unresolvedCount: 3,
      ageBuckets: {
        under15Minutes: 1,
        under1Hour: 1,
        under4Hours: 0,
        over4Hours: 1,
      },
      sla: {
        targetSeconds: 14400,
        attainedCount: 2,
        breachedCount: 1,
        attainmentPercent: 66.67,
      },
      resolvedTodayCount: 2,
      resolvedTodayWithinSlaCount: 1,
      retention: {
        liveAggregateRetentionSeconds: 2592000,
        policy: 'computed-on-demand',
      },
    }));
    expect(JSON.stringify(result)).not.toContain('reporterId');
    expect(JSON.stringify(result)).not.toContain('anonymousReporterId');
    expect(JSON.stringify(result)).not.toContain('confessionId');
    delete process.env.MODERATION_QUEUE_SLA_SECONDS;
  });

  it('returns a retryable server failure when metrics queries fail', async () => {
    const { service, reportRepository } = makeService();
    reportRepository.count.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(service.getReportQueueStats()).rejects.toMatchObject({
      status: 500,
      message: 'Moderation queue metrics are temporarily unavailable',
    });
  });

  it('groups only pending reports sharing the same confession and type', async () => {
    const date = new Date('2026-11-18T12:00:00.000Z');
    const reports = [
      {
        id: 'report-1',
        confessionId: 'confession-1',
        type: ReportType.SPAM,
        status: ReportStatus.PENDING,
        createdAt: date,
      },
      {
        id: 'report-2',
        confessionId: 'confession-1',
        type: ReportType.SPAM,
        status: ReportStatus.PENDING,
        createdAt: new Date(date.getTime() - 1000),
      },
      {
        id: 'report-3',
        confessionId: 'confession-1',
        type: ReportType.HARASSMENT,
        status: ReportStatus.PENDING,
        createdAt: date,
      },
    ] as unknown as Report[];
    const { service, reportRepository } = makeService(reports);

    const result = await service.findReportClusters(10);

    expect(result.scanned).toBe(3);
    expect(result.clusters).toEqual([
      expect.objectContaining({
        confessionId: 'confession-1',
        type: ReportType.SPAM,
        reportIds: ['report-1', 'report-2'],
        count: 2,
        signals: ['same confession', 'same report type'],
      }),
    ]);
    expect(reportRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 }),
    );
  });

  it('stores aggregate shadow results without fixture-level data', async () => {
    const { service, policyRunRows } = makeService();
    const run = await service.runShadowEvaluation(7, {
      fixtures: [
        { type: ReportType.SPAM, currentDecision: ReportStatus.PENDING },
        { type: ReportType.SPAM, currentDecision: ReportStatus.RESOLVED },
      ],
      rules: {
        [ReportType.SPAM]: {
          action: ReportStatus.RESOLVED,
          explanation: 'Matched the spam rule',
        },
      },
    });

    expect(run.result).toEqual(
      expect.objectContaining({
        fixtureCount: 2,
        disagreements: 1,
        disagreementRate: 0.5,
        byType: {
          [ReportType.SPAM]: { total: 2, disagreements: 1 },
        },
      }),
    );
    expect(run.details).not.toHaveProperty('fixtures');
    expect(policyRunRows).toHaveLength(1);
    expect(audit.logAction).toHaveBeenCalledWith(
      7,
      expect.anything(),
      'moderation_policy_run',
      'run-1',
      expect.objectContaining({ action: 'shadow_evaluated' }),
      null,
      undefined,
      expect.anything(),
    );
  });

  it('rejects invalid policy rules before persisting a run', async () => {
    const { service, policyRunRows } = makeService();

    await expect(
      service.runShadowEvaluation(7, {
        fixtures: [{ type: ReportType.SPAM, currentDecision: 'unknown' }],
        rules: {
          [ReportType.SPAM]: {
            action: ReportStatus.RESOLVED,
            explanation: 'Valid explanation',
          },
        },
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(policyRunRows).toHaveLength(0);
  });

  it('previews, commits, then rolls back a policy without overwriting later edits', async () => {
    const report = {
      id: 'report-1',
      confessionId: 'confession-1',
      type: ReportType.SPAM,
      status: ReportStatus.PENDING,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNotes: null,
      updatedAt: new Date('2026-11-18T12:00:00.000Z'),
    } as unknown as Report;
    const reportQuery = {
      where: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockImplementation(async () => [report]),
    };
    const reportRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(reportQuery),
      save: jest.fn().mockImplementation(async (records: Report[]) => {
        for (const record of records) {
          record.updatedAt = new Date(Date.now() + 1000);
        }
        return records;
      }),
    };
    const runs: ModerationPolicyRun[] = [];
    const runRepository = {
      create: jest.fn((record) => record),
      save: jest.fn(async (record: ModerationPolicyRun) => {
        if (!record.id) record.id = 'preview-1';
        const index = runs.findIndex(({ id }) => id === record.id);
        if (index >= 0) runs[index] = record;
        else runs.push(record);
        return record;
      }),
      findOne: jest.fn(async () => runs[0] ?? null),
    };
    const manager = {
      getRepository: (entity: unknown) =>
        entity === Report ? reportRepository : runRepository,
    };
    const transactionalPolicyRuns = {
      manager: {
        transaction: jest.fn(
          async (callback: (transactionManager: unknown) => unknown) =>
            callback(manager),
        ),
      },
    };
    const service = new ModerationGovernanceService(
      {} as unknown as Repository<ModerationAccessGrant>,
      transactionalPolicyRuns as unknown as Repository<ModerationPolicyRun>,
      reportRepository as unknown as Repository<Report>,
      {} as unknown as Repository<User>,
      audit as unknown as ModerationService,
    );
    const rules = {
      [ReportType.SPAM]: {
        action: ReportStatus.RESOLVED,
        explanation: 'Matched the spam rule',
      },
    };

    const preview = await service.previewPolicy(7, {
      reportIds: ['report-1'],
      rules,
    });
    expect(preview.records[0]).toEqual(
      expect.objectContaining({
        reportId: 'report-1',
        currentStatus: ReportStatus.PENDING,
        proposedStatus: ReportStatus.RESOLVED,
        explanation: 'Matched the spam rule',
      }),
    );
    expect(reportRepository.save).not.toHaveBeenCalled();

    await service.commitPolicyPreview(preview.previewId, 7);
    expect(report.status).toBe(ReportStatus.RESOLVED);

    const applied = (
      runs[0].details as {
        committedSnapshots: Array<{
          applied: {
            status: ReportStatus;
            resolvedBy: number;
            resolvedAt: string;
            resolutionNotes: string;
            updatedAt: string;
          };
        }>;
      }
    ).committedSnapshots[0].applied;
    report.resolutionNotes = 'Changed by another moderator';
    report.updatedAt = new Date();
    await expect(
      service.rollbackPolicy(preview.previewId, 7),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(report.resolutionNotes).toBe('Changed by another moderator');

    report.status = applied.status;
    report.resolvedBy = applied.resolvedBy;
    report.resolvedAt = new Date(applied.resolvedAt);
    report.resolutionNotes = applied.resolutionNotes;
    report.updatedAt = new Date(applied.updatedAt);
    await service.rollbackPolicy(preview.previewId, 7);
    expect(report.status).toBe(ReportStatus.PENDING);
    expect(report.resolvedBy).toBeNull();
    expect(report.resolutionNotes).toBeNull();
    expect(runs[0].status).toBe('rolled_back');
  });
});
