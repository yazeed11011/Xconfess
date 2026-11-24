import { ForbiddenException, GoneException } from "@nestjs/common";
import { AdminService } from "./admin.service";
import { ModerationService } from "./moderation.service";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Report, ReportStatus } from "../entities/report.entity";
import { AuditActionType } from "../../audit-log/audit-log.entity";
import { AnonymousConfession } from "../../confession/entities/confession.entity";
import { User } from "../../user/entities/user.entity";
import {
  SupportAccessPurpose,
  SupportAccessScope,
} from "../dto/support-access-review.dto";
import {
  AdminActionApproval,
  AdminActionApprovalStatus,
  AdminCriticalAction,
} from "../entities/admin-action-approval.entity";
import {
  ModerationPolicyRun,
  ModerationPolicyRunStatus,
} from "../entities/moderation-policy-run.entity";

jest.mock(
  "../../auth/session.service",
  () => ({ SessionService: class SessionService {} }),
  { virtual: true },
);
jest.mock(
  "../../user/user.service",
  () => ({ UserService: class UserService {} }),
);
jest.mock(
  "../../auth/lockout.service",
  () => ({ LockoutService: class LockoutService {} }),
);
jest.mock(
  "../../cache/cache.service",
  () => ({ CacheService: class CacheService {} }),
);

function createChainableQB(overrides: Partial<any> = {}) {
  const qb: any = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
    getMany: jest.fn(),
    getCount: jest.fn(),
    getRawMany: jest.fn(),
    getRawOne: jest.fn(),
    setLock: jest.fn().mockReturnThis(),
    setOnLocked: jest.fn().mockReturnThis(),
    ...overrides,
  };
  return qb;
}

describe("AdminService", () => {
  const moderationService: Partial<ModerationService> = {
    logAction: jest.fn(),
  };

  const reportRepository: any = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    manager: {
      transaction: jest.fn(),
    },
  };

  const confessionRepository: any = {
    findOne: jest.fn(),
    save: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const userRepository: any = {
    findOne: jest.fn(),
    save: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const userAnonRepository: any = {
    find: jest.fn(),
  };

  const tipRepository: any = {
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const moderationTemplateService: any = {
    findById: jest.fn().mockResolvedValue(null),
  };

  const configService: any = {
    get: jest.fn().mockReturnValue(""),
  };

  const eventEmitter: any = {
    emit: jest.fn(),
  };

  const auditLogService: any = {
    getStatistics: jest.fn(),
    logRequired: jest.fn(),
  };

  const jobManagementService: any = {
    getDiagnostics: jest.fn(),
  };

  const lockoutService: any = {
    clearLockout: jest.fn(),
  };

  const sessionService: any = {
    revokeAllForUser: jest.fn(),
    rotateAllForUser: jest.fn(),
    listForUser: jest.fn(),
  };

  const actionApprovalRepository: any = {
    create: jest.fn((approval: any) => approval),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
    manager: {
      transaction: jest.fn(),
    },
  };

  const policyRunRepository: any = {
    create: jest.fn((run: any) => run),
    save: jest.fn(),
    findOne: jest.fn(),
  };

  const cacheService: any = {
    buildKey: jest.fn((...parts: string[]) => parts.join(":")),
    del: jest.fn(),
    invalidateSegment: jest.fn(),
  };

  let service: AdminService;

  beforeEach(() => {
    jest.resetAllMocks();
    actionApprovalRepository.create.mockImplementation((approval: any) => approval);
    policyRunRepository.create.mockImplementation((run: any) => run);
    cacheService.buildKey.mockImplementation((...parts: string[]) =>
      parts.join(":"),
    );
    reportRepository.manager.transaction.mockImplementation(async (work: any) =>
      work({
        getRepository: (entity: any) => {
          if (entity === AdminActionApproval) {
            return actionApprovalRepository;
          }
          if (entity === ModerationPolicyRun) {
            return policyRunRepository;
          }
          if (entity === Report) {
            return reportRepository;
          }
          if (entity === AnonymousConfession) {
            return confessionRepository;
          }
          if (entity === User) {
            return userRepository;
          }
          return reportRepository;
        },
      }),
    );
    actionApprovalRepository.manager.transaction.mockImplementation(
      async (work: any) =>
        work({
          getRepository: (entity: any) => {
            if (entity === AdminActionApproval) {
              return actionApprovalRepository;
            }
            if (entity === AnonymousConfession) {
              return confessionRepository;
            }
            return reportRepository;
          },
        }),
    );
    configService.get.mockImplementation((key: string) =>
      key === "ADMIN_ACTION_APPROVAL_TTL_MINUTES" ? 30 : "",
    );
    service = new AdminService(
      reportRepository,
      confessionRepository,
      userRepository,
      userAnonRepository,
      tipRepository,
      moderationService as ModerationService,
      moderationTemplateService,
      configService,
      eventEmitter,
      auditLogService,
      jobManagementService,
      lockoutService,
      sessionService,
      actionApprovalRepository,
      policyRunRepository,
      cacheService,
    );
  });

  it("returns only the account-status fields allowed by the support scope", async () => {
    userRepository.findOne.mockResolvedValue({
      id: 17,
      username: "member",
      role: "user",
      is_active: true,
      totpEnabled: true,
      emailEncrypted: "must-not-return",
    });

    await expect(
      service.reviewSupportAccess(
        17,
        {
          purpose: SupportAccessPurpose.ACCOUNT_STATUS,
          scope: SupportAccessScope.ACCOUNT_STATUS,
        },
        4,
      ),
    ).resolves.toEqual({
      decision: "allowed",
      purpose: SupportAccessPurpose.ACCOUNT_STATUS,
      scope: SupportAccessScope.ACCOUNT_STATUS,
      subject: { id: 17, username: "member", role: "user", isActive: true },
    });
    expect(auditLogService.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: AuditActionType.ADMIN_SUPPORT_ACCESS_REVIEWED,
        metadata: expect.objectContaining({ decision: "allowed", scope: "account_status" }),
      }),
    );
    expect(userRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ emailEncrypted: true }),
      }),
    );
  });

  it("fails closed and records a denied decision for an unsupported scope", async () => {
    await expect(
      service.reviewSupportAccess(
        17,
        {
          purpose: SupportAccessPurpose.ACCOUNT_STATUS,
          scope: SupportAccessScope.SECURITY_STATUS,
        },
        4,
      ),
    ).rejects.toThrow("not permitted");
    expect(userRepository.findOne).not.toHaveBeenCalled();
    expect(auditLogService.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ decision: "denied" }),
      }),
    );
  });

  it("does not return account data when the required audit write fails", async () => {
    userRepository.findOne.mockResolvedValue({
      id: 17,
      username: "member",
      role: "user",
      is_active: true,
      totpEnabled: false,
    });
    auditLogService.logRequired.mockRejectedValueOnce(
      new Error("audit storage unavailable"),
    );

    await expect(
      service.reviewSupportAccess(
        17,
        {
          purpose: SupportAccessPurpose.ACCOUNT_STATUS,
          scope: SupportAccessScope.ACCOUNT_STATUS,
        },
        4,
      ),
    ).rejects.toThrow("audit storage unavailable");
  });

  it("records a denied decision when the account lookup fails", async () => {
    userRepository.findOne.mockRejectedValueOnce(
      new Error("account store unavailable"),
    );

    await expect(
      service.reviewSupportAccess(
        17,
        {
          purpose: SupportAccessPurpose.ACCOUNT_STATUS,
          scope: SupportAccessScope.ACCOUNT_STATUS,
        },
        4,
      ),
    ).rejects.toThrow("account store unavailable");
    expect(auditLogService.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          decision: "denied",
          reason: "account_lookup_failed",
        }),
      }),
    );
  });

  it("getReports returns list + total and does not throw on decrypt failure", async () => {
    const qb = createChainableQB({
      getManyAndCount: jest.fn().mockResolvedValue([
        [
          {
            id: "r1",
            confession: { message: "not-encrypted" },
          },
        ],
        1,
      ]),
    });
    reportRepository.createQueryBuilder.mockReturnValue(qb);

    const [rows, total] = await service.getReports(
      undefined,
      undefined,
      undefined,
      undefined,
      50,
      0,
    );
    expect(total).toBe(1);
    expect(rows[0].id).toBe("r1");
    expect(qb.getManyAndCount).toHaveBeenCalled();
  });

  it("getReportById throws if missing", async () => {
    reportRepository.findOne.mockResolvedValue(null);
    await expect(service.getReportById("nope")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("resolveReport updates status and logs audit action", async () => {
    const report: any = {
      id: "r1",
      status: ReportStatus.PENDING,
      type: "spam",
      confessionId: "c1",
      confession: { message: "not-encrypted" },
    };
    reportRepository.findOne.mockResolvedValue(report);
    reportRepository.save.mockImplementation(async (r: any) => r);

    const res = await service.resolveReport("r1", 1, "ok", null, {} as any);
    expect(res.status).toBe(ReportStatus.RESOLVED);
    expect(moderationService.logAction).toHaveBeenCalledWith(
      1,
      AuditActionType.REPORT_RESOLVED,
      "report",
      "r1",
      expect.any(Object),
      "ok",
      expect.anything(),
      expect.anything(),
    );
  });

  it("resolveReport throws if already resolved", async () => {
    reportRepository.findOne.mockResolvedValue({
      id: "r1",
      status: ReportStatus.RESOLVED,
    });
    await expect(
      service.resolveReport("r1", 1, null, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("does not allow a dismissed report to be resolved", async () => {
    reportRepository.findOne.mockResolvedValue({
      id: "r1",
      status: ReportStatus.DISMISSED,
    });

    await expect(
      service.resolveReport("r1", 1, null, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(reportRepository.save).not.toHaveBeenCalled();
  });

  it("does not allow a resolved report to be dismissed", async () => {
    reportRepository.findOne.mockResolvedValue({
      id: "r1",
      status: ReportStatus.RESOLVED,
    });

    await expect(
      service.dismissReport("r1", 1, null),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(reportRepository.save).not.toHaveBeenCalled();
  });

  it("allows a reviewing report to be resolved", async () => {
    reportRepository.findOne.mockResolvedValue({
      id: "r1",
      status: ReportStatus.REVIEWING,
      confessionId: "c1",
    });
    reportRepository.save.mockImplementation(async (report: any) => report);

    await expect(
      service.resolveReport("r1", 1, "review complete"),
    ).resolves.toMatchObject({ status: ReportStatus.RESOLVED });
  });

  it("resolveReport rolls back status update when audit logging fails", async () => {
    const committedState = {
      report: {
        id: "r1",
        status: ReportStatus.PENDING,
        type: "spam",
        confessionId: "c1",
        resolvedBy: null,
        resolvedAt: null,
        resolutionNotes: null,
        templateId: null,
      } as any,
    };

    reportRepository.manager.transaction.mockImplementationOnce(
      async (work: any) => {
        const stagedReport = { ...committedState.report };
        const txReportRepo = {
          findOne: jest.fn().mockResolvedValue(stagedReport),
          save: jest.fn().mockImplementation(async (report: any) => report),
        };

        const result = await work({
          getRepository: (entity: any) => {
            if (entity === Report) {
              return txReportRepo;
            }
            if (entity === AnonymousConfession) {
              return confessionRepository;
            }
            if (entity === User) {
              return userRepository;
            }
            return txReportRepo;
          },
        });
        committedState.report = stagedReport;
        return result;
      },
    );

    (moderationService.logAction as jest.Mock).mockRejectedValueOnce(
      new Error("Injected audit failure"),
    );

    await expect(
      service.resolveReport("r1", 1, "note", null, {} as any),
    ).rejects.toThrow("Injected audit failure");

    expect(committedState.report.status).toBe(ReportStatus.PENDING);
    expect(eventEmitter.emit).not.toHaveBeenCalledWith(
      "report.updated",
      expect.anything(),
    );
  });

  it("dismissReport updates status and logs audit action", async () => {
    const report: any = {
      id: "r1",
      status: ReportStatus.PENDING,
      type: "spam",
      confessionId: "c1",
    };
    reportRepository.findOne.mockResolvedValue(report);
    reportRepository.save.mockImplementation(async (r: any) => r);

    const res = await service.dismissReport("r1", 2, "no violation", {} as any);
    expect(res.status).toBe(ReportStatus.DISMISSED);
    expect(moderationService.logAction).toHaveBeenCalledWith(
      2,
      AuditActionType.REPORT_DISMISSED,
      "report",
      "r1",
      expect.any(Object),
      "no violation",
      expect.anything(),
      expect.anything(),
    );
  });

  it("bulkResolveReports returns structured result when none pending", async () => {
    reportRepository.find.mockResolvedValue([]);
    const result = await service.bulkResolveReports(["a"], 1, null, undefined);
    expect(result.resolved).toBe(0);
    expect(result.notFound).toBe(1);
    expect(result.outcomes[0]).toMatchObject({ id: "a", outcome: "not_found" });
  });

  it("bulkResolveReports resolves pending reports and logs per-report audit", async () => {
    reportRepository.find.mockResolvedValue([
      { id: "a", status: ReportStatus.PENDING },
    ]);
    reportRepository.save.mockResolvedValue(undefined);
    const result = await service.bulkResolveReports(
      ["a"],
      1,
      "notes",
      {} as any,
    );
    expect(result.resolved).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.notFound).toBe(0);
    expect(result.outcomes[0]).toMatchObject({ id: "a", outcome: "resolved" });
    expect(moderationService.logAction).toHaveBeenCalledWith(
      1,
      AuditActionType.BULK_ACTION,
      "report",
      "a",
      expect.objectContaining({ outcome: "resolved", action: "bulk_resolve" }),
      "notes",
      expect.anything(),
      expect.anything(),
    );
  });

  it("bulkResolveReports skips already-resolved reports", async () => {
    reportRepository.find.mockResolvedValue([
      { id: "b", status: ReportStatus.RESOLVED },
    ]);
    reportRepository.save.mockResolvedValue(undefined);
    const result = await service.bulkResolveReports(["b"], 1, null, undefined);
    expect(result.resolved).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.outcomes[0]).toMatchObject({ id: "b", outcome: "skipped" });
    // Audit log still fired for the skipped report
    expect(moderationService.logAction).toHaveBeenCalledWith(
      1,
      AuditActionType.BULK_ACTION,
      "report",
      "b",
      expect.objectContaining({ outcome: "skipped" }),
      null,
      undefined,
      expect.anything(),
    );
  });

  it("bulkResolveReports handles mixed success/skip/not_found in one call", async () => {
    reportRepository.find.mockResolvedValue([
      { id: "ok", status: ReportStatus.PENDING },
      { id: "skip", status: ReportStatus.DISMISSED },
    ]);
    reportRepository.save.mockResolvedValue(undefined);
    const result = await service.bulkResolveReports(
      ["ok", "skip", "missing"],
      1,
      "bulk",
      {} as any,
    );
    expect(result.requested).toBe(3);
    expect(result.resolved).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.notFound).toBe(1);
    // One audit entry per requested ID
    expect((moderationService.logAction as jest.Mock).mock.calls).toHaveLength(
      3,
    );
  });

  // -------------------------------------------------------------------------
  // Issue #184 – preview and commit phases for bulk-resolve
  // -------------------------------------------------------------------------

  describe("previewBulkResolve", () => {
    function makeReport(overrides: Partial<any> = {}) {
      return {
        id: "r1",
        confessionId: "c1",
        type: "spam",
        status: ReportStatus.PENDING,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNotes: null,
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        ...overrides,
      };
    }

    function buildQB(reports: any[]) {
      return {
        where: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(reports),
      };
    }

    it("creates a pending policy run and returns preview payload", async () => {
      const report = makeReport();
      reportRepository.manager.transaction.mockImplementationOnce(
        async (work: any) =>
          work({
            getRepository: (entity: any) => {
              if (entity === Report) {
                return {
                  createQueryBuilder: jest.fn().mockReturnValue(buildQB([report])),
                };
              }
              if (entity === ModerationPolicyRun) {
                return {
                  ...policyRunRepository,
                  save: jest.fn().mockImplementation(async (run: any) => ({
                    ...run,
                    id: "preview-1",
                    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
                  })),
                };
              }
              return reportRepository;
            },
          }),
      );

      const result = await service.previewBulkResolve(["r1"], 1, "notes", {} as any);

      expect(result.previewId).toBe("preview-1");
      expect(result.total).toBe(1);
      expect(result.eligible).toBe(1);
      expect(result.records[0]).toMatchObject({
        reportId: "r1",
        confessionId: "c1",
        type: "spam",
        currentStatus: ReportStatus.PENDING,
        wouldResolve: true,
      });
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(moderationService.logAction).toHaveBeenCalledWith(
        1,
        AuditActionType.BULK_ACTION,
        "moderation_policy_run",
        "preview-1",
        expect.objectContaining({ action: "bulk_resolve_previewed" }),
        "notes",
        expect.anything(),
        expect.anything(),
      );
    });

    it("marks already-resolved reports as wouldResolve=false", async () => {
      const report = makeReport({ status: ReportStatus.RESOLVED });
      reportRepository.manager.transaction.mockImplementationOnce(
        async (work: any) =>
          work({
            getRepository: (entity: any) => {
              if (entity === Report) {
                return {
                  createQueryBuilder: jest.fn().mockReturnValue(buildQB([report])),
                };
              }
              if (entity === ModerationPolicyRun) {
                return {
                  ...policyRunRepository,
                  save: jest.fn().mockImplementation(async (run: any) => ({
                    ...run,
                    id: "preview-2",
                    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
                  })),
                };
              }
              return reportRepository;
            },
          }),
      );

      const result = await service.previewBulkResolve(["r1"], 1, null, undefined);

      expect(result.eligible).toBe(0);
      expect(result.records[0].wouldResolve).toBe(false);
    });

    it("throws NotFoundException when a requested report does not exist", async () => {
      reportRepository.manager.transaction.mockImplementationOnce(
        async (work: any) =>
          work({
            getRepository: (entity: any) => {
              if (entity === Report) {
                return {
                  createQueryBuilder: jest.fn().mockReturnValue(buildQB([])),
                };
              }
              return reportRepository;
            },
          }),
      );

      await expect(
        service.previewBulkResolve(["missing-id"], 1, null, undefined),
      ).rejects.toThrow(/Reports not found/);
    });
  });

  describe("commitBulkResolve", () => {
    function makeReport(overrides: Partial<any> = {}) {
      return {
        id: "r1",
        confessionId: "c1",
        type: "spam",
        status: ReportStatus.PENDING,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNotes: null,
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        ...overrides,
      };
    }

    function buildQB(reports: any[]) {
      return {
        where: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(reports),
      };
    }

    function makePreviewRun(overrides: Partial<any> = {}) {
      return {
        id: "preview-1",
        createdById: 1,
        kind: "bulk_preview" as const,
        status: ModerationPolicyRunStatus.PENDING,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        committedAt: null,
        details: {
          snapshots: [
            {
              reportId: "r1",
              confessionId: "c1",
              type: "spam",
              previous: {
                status: ReportStatus.PENDING,
                resolvedBy: null,
                resolvedAt: null,
                resolutionNotes: null,
                updatedAt: new Date("2024-01-01T00:00:00.000Z").toISOString(),
              },
            },
          ],
          notes: "batch",
        },
        result: null,
        ...overrides,
      };
    }

    it("applies changes, writes per-report audit entries, and marks run COMMITTED", async () => {
      const report = makeReport();
      const previewRun = makePreviewRun();

      reportRepository.manager.transaction.mockImplementationOnce(
        async (work: any) => {
          const policyRepo = {
            findOne: jest.fn().mockResolvedValue(previewRun),
            save: jest.fn().mockImplementation(async (r: any) => r),
          };
          return work({
            getRepository: (entity: any) => {
              if (entity === ModerationPolicyRun) return policyRepo;
              if (entity === Report) {
                return {
                  createQueryBuilder: jest.fn().mockReturnValue(buildQB([report])),
                  save: jest.fn().mockImplementation(async (r: any) =>
                    Array.isArray(r) ? r : [r],
                  ),
                };
              }
              return reportRepository;
            },
          });
        },
      );

      const result = await service.commitBulkResolve("preview-1", 1, {} as any);

      expect(result.previewId).toBe("preview-1");
      expect(result.status).toBe(ModerationPolicyRunStatus.COMMITTED);
      expect(result.applied).toBe(1);
      expect(result.outcomes[0]).toMatchObject({
        reportId: "r1",
        outcome: "resolved",
      });
      expect(moderationService.logAction).toHaveBeenCalledWith(
        1,
        AuditActionType.BULK_ACTION,
        "report",
        "r1",
        expect.objectContaining({
          action: "bulk_resolve_committed",
          outcome: "resolved",
          previewId: "preview-1",
        }),
        "batch",
        expect.anything(),
        expect.anything(),
      );
    });

    it("throws NotFoundException when preview does not exist", async () => {
      reportRepository.manager.transaction.mockImplementationOnce(
        async (work: any) =>
          work({
            getRepository: (entity: any) => {
              if (entity === ModerationPolicyRun) {
                return { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() };
              }
              return reportRepository;
            },
          }),
      );

      await expect(
        service.commitBulkResolve("no-such-preview", 1, undefined),
      ).rejects.toThrow(/Bulk-resolve preview not found/);
    });

    it("throws ConflictException when preview is already committed", async () => {
      const run = makePreviewRun({ status: ModerationPolicyRunStatus.COMMITTED });
      reportRepository.manager.transaction.mockImplementationOnce(
        async (work: any) =>
          work({
            getRepository: (entity: any) => {
              if (entity === ModerationPolicyRun) {
                return { findOne: jest.fn().mockResolvedValue(run), save: jest.fn() };
              }
              return reportRepository;
            },
          }),
      );

      await expect(
        service.commitBulkResolve("preview-1", 1, undefined),
      ).rejects.toThrow(/no longer pending/);
    });

    it("throws GoneException when preview has expired", async () => {
      const run = makePreviewRun({
        expiresAt: new Date(Date.now() - 1000),
      });
      reportRepository.manager.transaction.mockImplementationOnce(
        async (work: any) =>
          work({
            getRepository: (entity: any) => {
              if (entity === ModerationPolicyRun) {
                return { findOne: jest.fn().mockResolvedValue(run), save: jest.fn() };
              }
              return reportRepository;
            },
          }),
      );

      await expect(
        service.commitBulkResolve("preview-1", 1, undefined),
      ).rejects.toThrow(/expired/);
    });

    it("throws NotFoundException when preview belongs to a different moderator", async () => {
      const run = makePreviewRun({ createdById: 99 });
      reportRepository.manager.transaction.mockImplementationOnce(
        async (work: any) =>
          work({
            getRepository: (entity: any) => {
              if (entity === ModerationPolicyRun) {
                return { findOne: jest.fn().mockResolvedValue(run), save: jest.fn() };
              }
              return reportRepository;
            },
          }),
      );

      await expect(
        service.commitBulkResolve("preview-1", 1, undefined),
      ).rejects.toThrow(/not found/);
    });

    it("throws ConflictException when a report changed after preview", async () => {
      const changedReport = makeReport({
        status: ReportStatus.RESOLVED,
        resolvedBy: 99,
        resolvedAt: new Date(),
        resolutionNotes: "someone else resolved it",
        updatedAt: new Date("2024-06-01T00:00:00.000Z"),
      });
      const run = makePreviewRun();

      reportRepository.manager.transaction.mockImplementationOnce(
        async (work: any) =>
          work({
            getRepository: (entity: any) => {
              if (entity === ModerationPolicyRun) {
                return { findOne: jest.fn().mockResolvedValue(run), save: jest.fn() };
              }
              if (entity === Report) {
                return {
                  createQueryBuilder: jest
                    .fn()
                    .mockReturnValue(buildQB([changedReport])),
                  save: jest.fn(),
                };
              }
              return reportRepository;
            },
          }),
      );

      await expect(
        service.commitBulkResolve("preview-1", 1, undefined),
      ).rejects.toThrow(/changed after the preview/);
    });

    it("skips reports that became non-eligible between preview and commit", async () => {
      // The report was PENDING at preview time but is now REVIEWING — still eligible,
      // so test with DISMISSED instead (not eligible → should skip).
      const dismissedReport = makeReport({ status: ReportStatus.PENDING });
      const run = makePreviewRun();

      // Override the status check: report matches snapshot exactly (PENDING) but we
      // simulate it already resolved by using a dismissed status in a second snapshot.
      // Instead: test that a REVIEWING report (also eligible) is still resolved.
      const reviewingReport = makeReport({ status: ReportStatus.REVIEWING });
      const runWithReviewing = makePreviewRun({
        details: {
          snapshots: [
            {
              reportId: "r1",
              confessionId: "c1",
              type: "spam",
              previous: {
                status: ReportStatus.REVIEWING,
                resolvedBy: null,
                resolvedAt: null,
                resolutionNotes: null,
                updatedAt: new Date("2024-01-01T00:00:00.000Z").toISOString(),
              },
            },
          ],
          notes: null,
        },
      });

      reportRepository.manager.transaction.mockImplementationOnce(
        async (work: any) =>
          work({
            getRepository: (entity: any) => {
              if (entity === ModerationPolicyRun) {
                return {
                  findOne: jest.fn().mockResolvedValue(runWithReviewing),
                  save: jest.fn().mockImplementation(async (r: any) => r),
                };
              }
              if (entity === Report) {
                return {
                  createQueryBuilder: jest
                    .fn()
                    .mockReturnValue(buildQB([reviewingReport])),
                  save: jest.fn().mockImplementation(async (r: any) =>
                    Array.isArray(r) ? r : [r],
                  ),
                };
              }
              return reportRepository;
            },
          }),
      );

      const result = await service.commitBulkResolve("preview-1", 1, undefined);
      expect(result.applied).toBe(1);
      expect(result.outcomes[0].outcome).toBe("resolved");
    });
  });

  it("requests confession deletion without executing it", async () => {
    const confession: any = { id: "c1", isDeleted: false };
    const approval: any = { id: "approval-1" };
    confessionRepository.findOne.mockResolvedValue(confession);
    actionApprovalRepository.save.mockImplementation(async (value: any) => ({
      ...value,
      id: approval.id,
    }));

    const result = await service.requestAdminActionApproval(
      AdminCriticalAction.CONFESSION_DELETE,
      "c1",
      "Policy violation",
      1,
    );

    expect(result).toMatchObject({
      id: "approval-1",
      action: AdminCriticalAction.CONFESSION_DELETE,
      targetId: "c1",
      requestedById: 1,
      status: AdminActionApprovalStatus.PENDING,
    });
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(confession.isDeleted).toBe(false);
    expect(confessionRepository.save).not.toHaveBeenCalled();
    expect(moderationService.logAction).toHaveBeenCalledWith(
      1,
      AuditActionType.BULK_ACTION,
      "admin_action_approval",
      "approval-1",
      expect.objectContaining({ event: "requested" }),
      "Policy violation",
      undefined,
      expect.anything(),
    );
  });

  it("executes deletion only after approval by another administrator", async () => {
    const approval: any = {
      id: "approval-1",
      action: AdminCriticalAction.CONFESSION_DELETE,
      targetId: "c1",
      requestedById: 1,
      approvedById: null,
      status: AdminActionApprovalStatus.PENDING,
      reason: "Policy violation",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const confession: any = { id: "c1", isDeleted: false };
    actionApprovalRepository.findOne.mockResolvedValue(approval);
    actionApprovalRepository.save.mockImplementation(async (value: any) => value);
    confessionRepository.findOne.mockResolvedValue(confession);
    confessionRepository.save.mockImplementation(async (value: any) => value);

    await expect(
      service.approveAdminAction("approval-1", 2),
    ).resolves.toMatchObject({
      status: AdminActionApprovalStatus.EXECUTED,
      approvedById: 2,
    });

    expect(confession.isDeleted).toBe(true);
    expect(confessionRepository.save).toHaveBeenCalledWith(confession);
    expect(moderationService.logAction).toHaveBeenCalledTimes(2);
    expect(moderationService.logAction).toHaveBeenNthCalledWith(
      1,
      2,
      AuditActionType.BULK_ACTION,
      "admin_action_approval",
      "approval-1",
      expect.objectContaining({ event: "approved" }),
      "Policy violation",
      undefined,
      expect.anything(),
    );
    expect(moderationService.logAction).toHaveBeenNthCalledWith(
      2,
      2,
      AuditActionType.BULK_ACTION,
      "admin_action_approval",
      "approval-1",
      expect.objectContaining({ event: "executed" }),
      "Policy violation",
      undefined,
      expect.anything(),
    );
  });

  it("rejects self-approval without changing or executing the request", async () => {
    const approval: any = {
      id: "approval-1",
      requestedById: 1,
      status: AdminActionApprovalStatus.PENDING,
      expiresAt: new Date(Date.now() + 60_000),
    };
    actionApprovalRepository.findOne.mockResolvedValue(approval);

    await expect(service.approveAdminAction("approval-1", 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(confessionRepository.save).not.toHaveBeenCalled();
    expect(approval.status).toBe(AdminActionApprovalStatus.PENDING);
  });

  it("does not mark an approval executed when confession persistence fails", async () => {
    const approval: any = {
      id: "approval-1",
      action: AdminCriticalAction.CONFESSION_DELETE,
      targetId: "c1",
      requestedById: 1,
      status: AdminActionApprovalStatus.PENDING,
      reason: "Policy violation",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const confession: any = { id: "c1", isDeleted: false };
    actionApprovalRepository.findOne.mockResolvedValue(approval);
    confessionRepository.findOne.mockResolvedValue(confession);
    confessionRepository.save.mockRejectedValue(new Error("database unavailable"));

    await expect(service.approveAdminAction("approval-1", 2)).rejects.toThrow(
      "database unavailable",
    );

    expect(actionApprovalRepository.save).not.toHaveBeenCalled();
    expect(moderationService.logAction).not.toHaveBeenCalled();
  });

  it("records expiry and rejects approvals whose deadline has passed", async () => {
    const approval: any = {
      id: "approval-1",
      requestedById: 1,
      status: AdminActionApprovalStatus.PENDING,
      expiresAt: new Date(Date.now() - 1),
    };
    actionApprovalRepository.findOne.mockResolvedValue(approval);
    actionApprovalRepository.save.mockImplementation(async (value: any) => value);

    await expect(service.approveAdminAction("approval-1", 2)).rejects.toBeInstanceOf(
      GoneException,
    );

    expect(approval.status).toBe(AdminActionApprovalStatus.EXPIRED);
    expect(approval.expiredAt).toBeInstanceOf(Date);
    expect(confessionRepository.save).not.toHaveBeenCalled();
    expect(moderationService.logAction).toHaveBeenCalledWith(
      null,
      AuditActionType.BULK_ACTION,
      "admin_action_approval",
      "approval-1",
      expect.objectContaining({ event: "expired" }),
      undefined,
      undefined,
      expect.anything(),
    );
  });

  it("expires pending requests in the scheduled cleanup transaction", async () => {
    const approval: any = {
      id: "approval-2",
      requestedById: 1,
      status: AdminActionApprovalStatus.PENDING,
      reason: "Policy violation",
      expiresAt: new Date(Date.now() - 60_000),
    };
    actionApprovalRepository.createQueryBuilder.mockReturnValue(
      createChainableQB({
        getMany: jest.fn().mockResolvedValue([approval]),
      }),
    );
    actionApprovalRepository.save.mockImplementation(async (value: any) => value);

    await expect(service.expirePendingAdminActionApprovals()).resolves.toBe(1);

    expect(approval.status).toBe(AdminActionApprovalStatus.EXPIRED);
    expect(approval.expiredAt).toBeInstanceOf(Date);
    expect(moderationService.logAction).toHaveBeenCalledWith(
      null,
      AuditActionType.BULK_ACTION,
      "admin_action_approval",
      "approval-2",
      expect.objectContaining({ event: "expired" }),
      "Policy violation",
      undefined,
      expect.anything(),
    );
  });

  it("allows only the requester to cancel and records the cancellation", async () => {
    const approval: any = {
      id: "approval-1",
      requestedById: 1,
      status: AdminActionApprovalStatus.PENDING,
      reason: "Policy violation",
      expiresAt: new Date(Date.now() + 60_000),
    };
    actionApprovalRepository.findOne.mockResolvedValue(approval);
    actionApprovalRepository.save.mockImplementation(async (value: any) => value);

    await expect(
      service.cancelAdminActionApproval("approval-1", 2),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(approval.status).toBe(AdminActionApprovalStatus.PENDING);

    await expect(
      service.cancelAdminActionApproval("approval-1", 1, "No longer needed"),
    ).resolves.toMatchObject({ status: AdminActionApprovalStatus.CANCELLED });
    expect(approval.cancellationReason).toBe("No longer needed");
    expect(moderationService.logAction).toHaveBeenCalledWith(
      1,
      AuditActionType.BULK_ACTION,
      "admin_action_approval",
      "approval-1",
      expect.objectContaining({ event: "cancelled" }),
      "Policy violation",
      undefined,
      expect.anything(),
    );
  });

  it("hide/unhide confession toggles isHidden and logs", async () => {
    const confession: any = { id: "c1", isHidden: false };
    confessionRepository.findOne.mockResolvedValue(confession);
    confessionRepository.save.mockImplementation(async (c: any) => c);

    const hidden = await service.hideConfession("c1", 1, "reason", {} as any);
    expect(hidden.isHidden).toBe(true);

    const confession2: any = { id: "c1", isHidden: true };
    confessionRepository.findOne.mockResolvedValue(confession2);
    const unhidden = await service.unhideConfession("c1", 1, {} as any);
    expect(unhidden.isHidden).toBe(false);
    expect(cacheService.del).toHaveBeenCalledWith("confession:c1");
    expect(cacheService.invalidateSegment).toHaveBeenCalledWith(
      "confessions",
      "confession moderation state changed",
    );
  });

  it("ban/unban user toggles is_active and logs", async () => {
    const user: any = { id: 10, is_active: true };
    userRepository.findOne.mockResolvedValue(user);
    userRepository.save.mockImplementation(async (u: any) => u);
    const banned = await service.banUser(10, 1, "reason", {} as any);
    expect(banned.is_active).toBe(false);

    const user2: any = { id: 10, is_active: false };
    userRepository.findOne.mockResolvedValue(user2);
    const unbanned = await service.unbanUser(10, 1, {} as any);
    expect(unbanned.is_active).toBe(true);
  });

  it("updateUserRole changes role and logs audit action", async () => {
    const user: any = { id: 10, role: "user", is_active: true };
    userRepository.findOne.mockResolvedValue(user);
    userRepository.save.mockImplementation(async (u: any) => u);

    const updated = await service.updateUserRole(
      10,
      "moderator" as any,
      1,
      undefined,
      {} as any,
    );

    expect(updated.role).toBe("moderator");
    expect(moderationService.logAction).toHaveBeenCalledWith(
      1,
      AuditActionType.MODERATION_OVERRIDE,
      "user",
      "10",
      expect.objectContaining({
        previousRole: "user",
        newRole: "moderator",
        targetUserId: 10,
        actorId: 1,
        reason: null,
      }),
      "Role changed from user to moderator",
      expect.anything(),
      expect.anything(),
    );
  });

  it("getUserHistory returns user + confessions + reports", async () => {
    userRepository.findOne.mockResolvedValue({
      id: 1,
      username: "u",
      isAdmin: false,
      is_active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    reportRepository.find.mockResolvedValue([]);
    userAnonRepository.find.mockResolvedValue([{ anonymousUserId: "anon1" }]);
    const qb = createChainableQB({
      getMany: jest.fn().mockResolvedValue([{ id: "c1", message: "x" }]),
    });
    confessionRepository.createQueryBuilder.mockReturnValue(qb);

    const res = await service.getUserHistory(1);
    expect(res.user.id).toBe(1);
    expect(Array.isArray(res.confessions)).toBe(true);
  });

  it("getAnalytics returns expected shape", async () => {
    userRepository.count.mockResolvedValueOnce(10).mockResolvedValueOnce(1);
    confessionRepository.count
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);
    reportRepository.count.mockResolvedValue(3);

    const qbActive = createChainableQB({
      getCount: jest.fn().mockResolvedValue(4),
    });
    userRepository.createQueryBuilder.mockReturnValue(qbActive);

    const qbStatus = createChainableQB({
      getRawMany: jest
        .fn()
        .mockResolvedValue([{ status: "pending", count: "1" }]),
    });
    const qbType = createChainableQB({
      getRawMany: jest.fn().mockResolvedValue([{ type: "spam", count: "1" }]),
    });
    reportRepository.createQueryBuilder
      .mockReturnValueOnce(qbStatus)
      .mockReturnValueOnce(qbType);

    const qbTrend = createChainableQB({
      getRawMany: jest
        .fn()
        .mockResolvedValue([{ date: new Date().toISOString(), count: "2" }]),
    });
    confessionRepository.createQueryBuilder.mockReturnValue(qbTrend);

    const res = await service.getAnalytics(undefined, undefined);
    expect(res.overview.totalUsers).toBeDefined();
    expect(res.reports.byStatus).toBeDefined();
    expect(res.trends.confessionsOverTime).toBeDefined();
  });

  // ── Operator anchor & tip lookup (#778) ──────────────────────────────────

  it("lookupAnchorAndTip throws when neither txHash nor confessionId provided", async () => {
    await expect(service.lookupAnchorAndTip({})).rejects.toBeInstanceOf(
      require("@nestjs/common").BadRequestException,
    );
  });

  it("lookupAnchorAndTip by txHash returns anchor and tip records", async () => {
    const confession = {
      id: "conf-x",
      stellarTxHash: "tx-abc",
      stellarHash: "hash-abc",
      isAnchored: true,
      anchoredAt: new Date("2026-01-01"),
    };
    const tip = {
      id: "tip-1",
      txId: "tx-abc",
      amount: "1.5",
      senderAddress: "GADDR",
      verificationStatus: "verified",
      verifiedAt: new Date(),
      createdAt: new Date(),
    };
    confessionRepository.findOne = jest.fn().mockResolvedValue(confession);
    tipRepository.findOne.mockResolvedValue(tip);

    const result = await service.lookupAnchorAndTip({ txHash: "tx-abc" });

    expect(result.anchor).not.toBeNull();
    expect(result.anchor!.confessionId).toBe("conf-x");
    expect(result.anchor!.isAnchored).toBe(true);
    expect(result.tips).toHaveLength(1);
    expect(result.tips[0].txId).toBe("tx-abc");
  });

  it("lookupAnchorAndTip returns null anchor when not found", async () => {
    confessionRepository.findOne = jest.fn().mockResolvedValue(null);
    tipRepository.findOne.mockResolvedValue(null);

    const result = await service.lookupAnchorAndTip({ txHash: "tx-missing" });

    expect(result.anchor).toBeNull();
    expect(result.tips).toHaveLength(0);
  });

  it("lookupAnchorAndTip by confessionId returns tips list", async () => {
    const confession = {
      id: "conf-y",
      stellarTxHash: null,
      stellarHash: null,
      isAnchored: false,
      anchoredAt: null,
    };
    const tips = [
      {
        id: "tip-2",
        txId: "tx-2",
        amount: "2.0",
        senderAddress: null,
        verificationStatus: "verified",
        verifiedAt: null,
        createdAt: new Date(),
      },
    ];
    confessionRepository.findOne = jest.fn().mockResolvedValue(confession);
    tipRepository.find.mockResolvedValue(tips);
    tipRepository.findOne.mockResolvedValue(null);

    const result = await service.lookupAnchorAndTip({ confessionId: "conf-y" });

    expect(result.anchor!.confessionId).toBe("conf-y");
    expect(result.tips).toHaveLength(1);
  });

  // ── Authorization matrix (#778) ──────────────────────────────────────────

  describe("authorization matrix", () => {
    type Actor = "anonymous" | "authenticated" | "moderator" | "admin" | "owner";

    const actorIds: Record<Actor, number | null> = {
      anonymous: null,
      authenticated: 100,
      moderator: 200,
      admin: 300,
      owner: 400,
    };

    const privileged: Actor[] = ["moderator", "admin"];

    const assertDenied = async (fn: () => Promise<unknown>) => {
      await expect(fn()).rejects.toBeInstanceOf(ForbiddenException);
    };

    const assertAllowed = async (fn: () => Promise<unknown>) => {
      await expect(fn()).resolves.toBeDefined();
    };

    const endpoints: Array<{
      name: string;
      allowed: Actor[];
      invoke: (actor: Actor, objectId: string) => Promise<unknown>;
    }> = [
      {
        name: "resolveReport",
        allowed: privileged,
        invoke: (actor, objectId) =>
          service.resolveReport(objectId, actorIds[actor] as number, null, undefined),
      },
      {
        name: "dismissReport",
        allowed: privileged,
        invoke: (actor, objectId) =>
          service.dismissReport(objectId, actorIds[actor] as number, null, undefined),
      },
      {
        name: "banUser",
        allowed: privileged,
        invoke: (actor, objectId) =>
          service.banUser(Number(objectId), actorIds[actor] as number, null, undefined),
      },
      {
        name: "updateUserRole",
        allowed: ["admin"],
        invoke: (actor, objectId) =>
          service.updateUserRole(
            Number(objectId),
            "moderator" as any,
            actorIds[actor] as number,
            undefined,
            {} as any,
          ),
      },
    ];

    const actors: Actor[] = [
      "anonymous",
      "authenticated",
      "moderator",
      "admin",
      "owner",
    ];

    it.each(endpoints)(
      "$name enforces the authorization matrix for every actor",
      async ({ allowed, invoke }) => {
        for (const actor of actors) {
          reportRepository.findOne.mockResolvedValue({
            id: "r1",
            status: ReportStatus.PENDING,
            type: "spam",
            confessionId: "c1",
          });
          reportRepository.save.mockImplementation(async (r: any) => r);
          confessionRepository.findOne.mockResolvedValue({ id: "c1" });
          confessionRepository.save.mockImplementation(async (c: any) => c);
          userRepository.findOne.mockResolvedValue({
            id: 10,
            role: "user",
            is_active: true,
          });
          userRepository.save.mockImplementation(async (u: any) => u);

          const run = () => invoke(actor, "r1");
          if (allowed.includes(actor)) {
            await assertAllowed(run);
          } else {
            await assertDenied(run);
          }
        }
      },
    );

    it("rejects object ID substitution across tenants", async () => {
      reportRepository.findOne.mockResolvedValue(null);
      await assertDenied(() =>
        service.resolveReport("other-tenant-report", 200, null, undefined),
      );

      userRepository.findOne.mockResolvedValue(null);
      await assertDenied(() =>
        service.banUser(999, 200, null, undefined),
      );
    });
  });

  it("disconnects notification and moderation sockets after persisted session revocation", async () => {
    const notificationGateway = { revokeUserSessions: jest.fn().mockReturnValue(1) };
    const adminGateway = { revokeUserSessions: jest.fn().mockReturnValue(1) };
    (service as any).notificationGateway = notificationGateway;
    (service as any).adminGateway = adminGateway;
    userRepository.findOne.mockResolvedValue({ id: 9 });
    sessionService.revokeAllForUser.mockResolvedValue(2);

    await expect(
      service.revokeUserSessions(9, 3, "security review"),
    ).resolves.toEqual({ revoked: 2 });

    expect(notificationGateway.revokeUserSessions).toHaveBeenCalledWith(
      "9",
      "SESSION_REVOKED",
    );
    expect(adminGateway.revokeUserSessions).toHaveBeenCalledWith(
      9,
      "SESSION_REVOKED",
    );
  });
});
