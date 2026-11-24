import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  ConflictException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiBody,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { StepUpGuard } from '../auth/guards/step-up.guard';
import { CapabilityGuard } from '../auth/capabilities/capability.guard';
import { RequireCapability } from '../auth/capabilities/require-capability.decorator';
import { ResponseSizeBudget } from '../common/interceptors/response-size.interceptor';
import {
  CAPABILITY_MANAGE_USERS,
  CAPABILITY_MODERATE_CONTENT,
  CAPABILITY_READ_AUDIT_LOG,
  CAPABILITY_RUN_DIAGNOSTICS,
  CAPABILITY_VIEW_ANALYTICS,
} from '../auth/capabilities/capability.constants';
import { AdminService } from './services/admin.service';
import { ModerationService } from './services/moderation.service';
import { ModerationTemplateService } from '../comment/moderation-template.service';
import { ResolveReportDto } from './dto/resolve-report.dto';
import { BanUserDto } from './dto/ban-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { BulkResolveDto, BulkResolvePreviewDto } from './dto/bulk-resolve.dto';
import { ReportStatus, ReportType } from './entities/report.entity';
import { AuditActionType } from '../audit-log/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TemplateCategory } from '../comment/entities/moderation-note-template.entity';
import { UserRole } from '../user/entities/user.entity';
import { Request } from 'express';
import { GetUser } from '../auth/get-user.decorator';
import { RequestUser } from '../auth/interfaces/jwt-payload.interface';
import { StellarDiagnosticsService } from './services/stellar-diagnostics.service';
import { DiagnosticsBundleService } from './services/diagnostics-bundle.service';
import { RankingDriftService } from '../ranking/ranking-drift.service';
import {
  CrossDomainIntegrityService,
  IntegrityDomain,
} from './services/cross-domain-integrity.service';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsNotEmpty,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  CancelActionApprovalDto,
  RequestActionApprovalDto,
} from './dto/request-action-approval.dto';
import { SupportAccessReviewDto } from './dto/support-access-review.dto';
import { ModerationAccessGrantGuard } from '../auth/guards/moderation-access-grant.guard';
import { RequireModerationAccessGrant } from '../auth/guards/moderation-access-grant.decorator';

export class CreateTemplateDto {
  @IsNotEmpty({ message: 'Name is required' })
  @IsString({ message: 'Name must be a string' })
  @MinLength(1, { message: 'Name must not be empty' })
  @MaxLength(100, { message: 'Name must be at most 100 characters' })
  name: string;

  @IsNotEmpty({ message: 'Content is required' })
  @IsString({ message: 'Content must be a string' })
  @MinLength(1, { message: 'Content must not be empty' })
  content: string;

  @IsNotEmpty({ message: 'Category is required' })
  @IsEnum(TemplateCategory, {
    message: 'Category must be a valid template category',
  })
  category: TemplateCategory;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString({ message: 'Name must be a string' })
  @MinLength(1, { message: 'Name must not be empty' })
  @MaxLength(100, { message: 'Name must be at most 100 characters' })
  name?: string;

  @IsOptional()
  @IsString({ message: 'Content must be a string' })
  @MinLength(1, { message: 'Content must not be empty' })
  content?: string;

  @IsOptional()
  @IsEnum(TemplateCategory, {
    message: 'Category must be a valid template category',
  })
  category?: TemplateCategory;

  @IsOptional()
  isActive?: boolean;
}

export class ExportAuditDto {
  @IsNotEmpty()
  @IsString()
  label: string;

  @IsOptional()
  rowCount?: number;

  @IsOptional()
  filters?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  requestId?: string;
}

type AuthedRequest = Request & { user?: RequestUser };

const auditActionTypeValues = new Set<string>(
  Object.values(AuditActionType) as string[],
);

function parseAuditAction(value?: string): AuditActionType | undefined {
  if (!value) {
    return undefined;
  }

  return auditActionTypeValues.has(value)
    ? (value as AuditActionType)
    : undefined;
}

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard, CapabilityGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly moderationService: ModerationService,
    private readonly moderationTemplateService: ModerationTemplateService,
    private readonly auditLogService: AuditLogService,
    private readonly stellarDiagnosticsService: StellarDiagnosticsService,
    private readonly diagnosticsBundleService: DiagnosticsBundleService,
    private readonly rankingDriftService: RankingDriftService,
    private readonly crossDomainIntegrityService: CrossDomainIntegrityService,
  ) {}

  // Reports
  @Get('reports')
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @ResponseSizeBudget(1024 * 1024)
  @ApiOperation({ summary: 'List reports with optional filters and cursor pagination' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ReportStatus,
    description: 'Filter by status',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ReportType,
    description: 'Filter by report type',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    example: '2026-04-01',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    example: '2026-04-30',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque cursor for cursor-based pagination' })
  @ApiResponse({
    status: 200,
    description: 'Paginated report list.',
    schema: {
      example: {
        data: [
          {
            id: 'abc-123',
            confessionId: 'def-456',
            status: 'pending',
            type: 'spam',
          },
        ],
        nextCursor: 'eyJpZCI6MTIzLCJjcmVhdGVkQXQiOiIyMDI0LTAxLTAxVDAwOjAwOjAwWiJ9',
        hasMore: false,
        limit: 20,
      },
    },
  })
  async getReports(
    @Query('status') status?: ReportStatus,
    @Query('type') type?: ReportType,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    return this.adminService.getReportsCursor(
      status,
      type,
      start,
      end,
      // Issue #181: the page size is bounded so a single request cannot ask
      // for an arbitrarily large result set.
      Math.min(Math.max(parseInt(limit || '20', 10) || 20, 1), 100),
      cursor,
    );
  }

  @Get('reports/stats')
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @ApiOperation({ summary: 'Get report queue health stats' })
  @ApiResponse({
    status: 200,
    description: 'Report queue metrics.',
    schema: {
      example: {
        pendingCount: 5,
        oldestUnresolvedAge: 86400,
        resolvedTodayCount: 3,
      },
    },
  })
  async getReportStats() {
    return this.adminService.getReportStats();
  }

  @Get('reports/:id')
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @ApiOperation({ summary: 'Get a single report by ID' })
  @ApiParam({ name: 'id', description: 'Report UUID' })
  @ApiResponse({ status: 200, description: 'Report record.' })
  @ApiResponse({ status: 404, description: 'Report not found.' })
  async getReportById(@Param('id') id: string) {
    return this.adminService.getReportById(id);
  }

  @Patch('reports/:id/resolve')
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @HttpCode(HttpStatus.OK)
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @ApiOperation({ summary: 'Resolve a report (admin action)' })
  @ApiParam({ name: 'id', description: 'Report UUID' })
  @ApiBody({
    schema: {
      example: {
        resolutionNotes: 'Content removed — violates community guidelines.',
        templateId: 3,
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Report resolved successfully.' })
  async resolveReport(
    @Param('id') id: string,
    @Body() dto: ResolveReportDto,
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.adminService.resolveReport(
      id,
      adminId,
      dto.resolutionNotes || null,
      dto.templateId,
      req,
    );
  }

  @Patch('reports/:id/dismiss')
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @HttpCode(HttpStatus.OK)
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @ApiOperation({ summary: 'Dismiss a report without taking action' })
  @ApiParam({ name: 'id', description: 'Report UUID' })
  @ApiResponse({ status: 200, description: 'Report dismissed.' })
  async dismissReport(
    @Param('id') id: string,
    @Body() dto: ResolveReportDto,
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.adminService.dismissReport(
      id,
      adminId,
      dto.resolutionNotes || null,
      req,
    );
  }

  @Patch('reports/bulk-resolve')
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @HttpCode(HttpStatus.OK)
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @ApiOperation({ summary: 'Bulk-resolve multiple reports at once' })
  @ApiBody({
    schema: {
      example: {
        reportIds: ['abc-123', 'def-456'],
        notes: 'Batch resolution — content removed.',
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'All listed reports resolved.',
    schema: { example: { resolved: 2, failed: 0 } },
  })
  async bulkResolveReports(
    @Body() dto: BulkResolveDto,
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.adminService.bulkResolveReports(
      dto.reportIds,
      adminId,
      dto.notes || null,
      req,
    );
  }

  /**
   * Issue #184 – Preview phase for bulk-resolve.
   *
   * Returns the exact target set and the per-report consequence (would resolve /
   * would skip) without changing any record.  The response includes a previewId
   * that expires in 10 minutes and must be passed to the commit endpoint.
   */
  @Post('reports/bulk-resolve/preview')
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @ApiOperation({
    summary: 'Preview bulk-resolve — see target set and consequences without applying',
  })
  @ApiBody({
    schema: {
      example: {
        reportIds: ['abc-123', 'def-456'],
        notes: 'Batch resolution — content removed.',
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Preview created.  Use previewId to commit within 10 minutes.',
  })
  async previewBulkResolve(
    @Body() dto: BulkResolvePreviewDto,
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.adminService.previewBulkResolve(
      dto.reportIds,
      adminId,
      dto.notes ?? null,
      req,
    );
  }

  /**
   * Issue #184 – Commit phase for bulk-resolve.
   *
   * Applies the changes captured by a pending, unexpired preview.  Rejects if
   * any report changed state between preview and commit.
   */
  @Post('reports/bulk-resolve/:previewId/commit')
  @UseGuards(ModerationAccessGrantGuard)
  @RequireModerationAccessGrant()
  @HttpCode(HttpStatus.OK)
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @ApiOperation({
    summary: 'Commit a pending bulk-resolve preview',
  })
  @ApiResponse({ status: 200, description: 'Preview committed.' })
  @ApiResponse({ status: 404, description: 'Preview not found.' })
  @ApiResponse({ status: 409, description: 'Preview is no longer pending or a report changed.' })
  @ApiResponse({ status: 410, description: 'Preview has expired.' })
  async commitBulkResolve(
    @Param('previewId') previewId: string,
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.adminService.commitBulkResolve(previewId, adminId, req);
  }

  // Confessions
  @Get('action-approvals')
  @ApiOperation({
    summary: 'List pending high-impact admin action approvals',
  })
  async getPendingActionApprovals() {
    return this.adminService.findPendingAdminActionApprovals();
  }

  @Post('action-approvals')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Request approval for a high-impact admin action' })
  @ApiResponse({ status: 201, description: 'Approval request created.' })
  async requestActionApproval(
    @Body() dto: RequestActionApprovalDto,
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.adminService.requestAdminActionApproval(
      dto.action,
      dto.targetId,
      dto.reason,
      adminId,
      req,
    );
  }

  @Post('action-approvals/:id/approve')
  @UseGuards(StepUpGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve and execute a pending action as a second administrator',
  })
  @ApiResponse({ status: 410, description: 'Approval request has expired.' })
  async approveActionApproval(
    @Param('id') id: string,
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.adminService.approveAdminAction(id, adminId, req);
  }

  @Post('action-approvals/:id/cancel')
  @UseGuards(StepUpGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an action approval request you created' })
  async cancelActionApproval(
    @Param('id') id: string,
    @Body() dto: CancelActionApprovalDto,
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.adminService.cancelAdminActionApproval(
      id,
      adminId,
      dto.reason,
      req,
    );
  }

  @Delete('confessions/:id')
  @UseGuards(StepUpGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deprecated direct confession deletion endpoint' })
  @ApiParam({ name: 'id', description: 'Confession UUID' })
  @ApiResponse({
    status: 409,
    description:
      'Direct deletion is disabled; submit and receive a second-admin approval.',
  })
  async deleteConfession(): Promise<never> {
    throw new ConflictException({
      code: 'ADMIN_ACTION_APPROVAL_REQUIRED',
      message:
        'Confession deletion requires a second administrator. Submit POST /api/admin/action-approvals.',
    });
  }

  @Patch('confessions/:id/hide')
  @UseGuards(StepUpGuard)
  @HttpCode(HttpStatus.OK)
  @UseGuards(StepUpGuard)
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @ApiOperation({ summary: 'Hide a confession from public view (admin only)' })
  @ApiParam({ name: 'id', description: 'Confession UUID' })
  @ApiResponse({ status: 200, description: 'Confession hidden.' })
  @ApiResponse({
    status: 403,
    description: 'Missing or expired step-up proof.',
  })
  async hideConfession(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.adminService.hideConfession(
      id,
      adminId,
      body.reason || null,
      req,
    );
  }

  @Patch('confessions/:id/unhide')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(CAPABILITY_MODERATE_CONTENT)
  @ApiOperation({ summary: 'Unhide a confession (admin only)' })
  @ApiParam({ name: 'id', description: 'Confession UUID' })
  @ApiResponse({ status: 200, description: 'Confession unhidden.' })
  async unhideConfession(
    @Param('id') id: string,
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.adminService.unhideConfession(id, adminId, req);
  }

  // Users
  @Get('users/search')
  @RequireCapability(CAPABILITY_MANAGE_USERS)
  @ApiOperation({ summary: 'Search users by username with cursor pagination' })
  @ApiQuery({ name: 'q', description: 'Search query', example: 'alice' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque cursor for cursor-based pagination' })
  @ApiResponse({
    status: 200,
    description: 'Matching users with cursor pagination.',
    schema: {
      example: {
        data: [{ id: 1, username: 'alice_42', role: 'user' }],
        nextCursor: null,
        hasMore: false,
        limit: 20,
      },
    },
  })
  async searchUsers(
    @Query('q') query: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    if (!query) {
      return { data: [], nextCursor: null, hasMore: false, limit: 20 };
    }
    return this.adminService.searchUsersCursor(
      query,
      parseInt(limit || '20', 10),
      cursor,
    );
  }

  @Post('users/:id/support-review')
  @RequireCapability(CAPABILITY_MANAGE_USERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Review a minimized account snapshot for a documented support purpose',
  })
  @ApiParam({ name: 'id', description: 'User numeric ID' })
  @ApiResponse({
    status: 200,
    description: 'Minimized account snapshot after an audited access decision.',
  })
  async reviewSupportAccess(
    @Param('id') id: string,
    @Body() dto: SupportAccessReviewDto,
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.adminService.reviewSupportAccess(
      Number(id),
      dto,
      adminId,
      req,
    );
  }

  @Get('users/:id/history')
  @RequireCapability(CAPABILITY_MANAGE_USERS)
  async getUserHistory(@Param('id') id: string) {
    return this.adminService.getUserHistory(parseInt(id, 10));
  }

  @Post('users/unlock-account')
  @HttpCode(HttpStatus.OK)
  @UseGuards(StepUpGuard)
  @ApiOperation({ summary: 'Unlock a locked account by email' })
  @ApiBody({ schema: { example: { email: 'user@example.com' } } })
  @ApiResponse({ status: 200, description: 'Account unlocked.' })
  async unlockAccount(@Body('email') email: string) {
    await this.adminService.unlockAccount(email);
    return { message: `Account unlocked for ${email}` };
  }

  @Patch('users/:id/role')
  @UseGuards(StepUpGuard)
  @HttpCode(HttpStatus.OK)
  @UseGuards(StepUpGuard)
  @RequireCapability(CAPABILITY_MANAGE_USERS)
  @ApiOperation({ summary: 'Change a user role' })
  @ApiParam({ name: 'id', description: 'User numeric ID' })
  @ApiBody({ schema: { example: { role: UserRole.MODERATOR } } })
  @ApiResponse({ status: 200, description: 'User role updated.' })
  @ApiResponse({
    status: 403,
    description: 'Missing or expired step-up proof.',
  })
  async updateUserRole(
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.adminService.updateUserRole(
      parseInt(id, 10),
      dto.role,
      adminId,
      (dto as any).reason || null,
      req,
    );
  }

  @Patch('users/:id/ban')
  @UseGuards(StepUpGuard)
  @HttpCode(HttpStatus.OK)
  @UseGuards(StepUpGuard)
  @RequireCapability(CAPABILITY_MANAGE_USERS)
  @ApiOperation({ summary: 'Ban a user account' })
  @ApiParam({ name: 'id', description: 'User numeric ID' })
  @ApiBody({
    schema: {
      example: { reason: 'Repeated policy violations.', durationDays: 30 },
    },
  })
  @ApiResponse({ status: 200, description: 'User banned.' })
  @ApiResponse({
    status: 403,
    description: 'Missing or expired step-up proof.',
  })
  async banUser(
    @Param('id') id: string,
    @Body() dto: BanUserDto,
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.adminService.banUser(
      parseInt(id, 10),
      adminId,
      dto.reason || null,
      req,
      dto.durationDays ?? null,
    );
  }

  @Patch('users/:id/unban')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(CAPABILITY_MANAGE_USERS)
  @ApiOperation({ summary: 'Lift a user ban' })
  @ApiParam({ name: 'id', description: 'User numeric ID' })
  @ApiResponse({ status: 200, description: 'User unbanned.' })
  async unbanUser(
    @Param('id') id: string,
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.adminService.unbanUser(parseInt(id, 10), adminId, req);
  }

  // Moderation Note Templates
  @Get('templates')
  async getTemplates(@Query('includeInactive') includeInactive?: string) {
    return this.moderationTemplateService.findAll(includeInactive === 'true');
  }

  @Get('templates/:id')
  async getTemplateById(@Param('id') id: string) {
    return this.moderationTemplateService.findById(parseInt(id, 10));
  }

  @Post('templates')
  @HttpCode(HttpStatus.CREATED)
  async createTemplate(
    @Body() dto: CreateTemplateDto,
    @GetUser('id') adminId: number,
  ) {
    return this.moderationTemplateService.create(dto, adminId);
  }

  @Patch('templates/:id')
  async updateTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.moderationTemplateService.update(parseInt(id, 10), dto);
  }

  @Delete('templates/:id')
  @UseGuards(StepUpGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTemplate(@Param('id') id: string) {
    await this.moderationTemplateService.delete(parseInt(id, 10));
  }

  // Stellar diagnostics (Issue #1119)
  @Get('stellar/diagnostics')
  @RequireCapability(CAPABILITY_RUN_DIAGNOSTICS)
  @ApiOperation({
    summary: 'Stellar network and contract diagnostics with Horizon liveness ping',
    description:
      'Returns configured network, contract IDs, and a live Horizon reachability check. ' +
      'Never exposes secrets. Horizon unreachable returns a degraded indicator, not a 500.',
  })
  @ApiResponse({
    status: 200,
    description: 'Stellar diagnostics result',
    schema: {
      example: {
        network: 'testnet',
        horizonUrl: 'https://horizon-testnet.stellar.org',
        sorobanRpcUrl: 'https://soroban-rpc-testnet.stellar.org',
        contractIds: {
          confessionAnchor: 'CB5XMDHT66EISB4WXM4YGNDHYRMZDX42TOHZEAENIUTSSMRFHJSFRNHB',
          reputationBadges: null,
          tippingSystem: null,
        },
        horizonStatus: 'ok',
        horizonLatencyMs: 142,
        deploymentMetadata: {
          loaded: true,
          generatedAtUtc: '2026-05-21T12:34:56Z',
          isStale: false,
          ageDays: 7,
          loadError: null,
        },
        checkedAt: '2026-06-20T10:00:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 403, description: 'Forbidden — admin role required.' })
  async getStellarDiagnostics() {
    return this.stellarDiagnosticsService.getDiagnostics();
  }

  // Operator anchor & tip lookup (Issue #778)
  @Get('lookup/anchor-tip')
  async lookupAnchorAndTip(
    @Query('txHash') txHash?: string,
    @Query('confessionId') confessionId?: string,
  ) {
    return this.adminService.lookupAnchorAndTip({ txHash, confessionId });
  }
  // Analytics
  @Get('analytics')
  @RequireCapability(CAPABILITY_VIEW_ANALYTICS)
  @ResponseSizeBudget(1024 * 1024)
  @ApiOperation({ summary: 'Get platform analytics (optionally date-bounded)' })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    example: '2026-04-01',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    example: '2026-04-30',
  })
  @ApiResponse({
    status: 200,
    description: 'Aggregated platform metrics.',
    schema: {
      example: {
        totalConfessions: 1420,
        totalUsers: 380,
        totalReports: 42,
        totalReactions: 8500,
      },
    },
  })
  async getAnalytics(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    return this.adminService.getAnalytics(start, end);
  }

  // Audit Logs
  @Get('audit-logs')
  @RequireCapability(CAPABILITY_READ_AUDIT_LOG)
  @ResponseSizeBudget(2 * 1024 * 1024)
  @ApiOperation({ summary: 'Query the admin audit log' })
  @ApiQuery({
    name: 'adminId',
    required: false,
    description: 'Filter by admin user ID',
  })
  @ApiQuery({
    name: 'actor',
    required: false,
    description: 'Filter by actor username, label, or ID',
  })
  @ApiQuery({
    name: 'action',
    required: false,
    description: 'Filter by action type',
  })
  @ApiQuery({
    name: 'entityType',
    required: false,
    description: 'Filter by entity type (e.g. confession, user)',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Full-text keyword search across audit entries',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'actor', 'action', 'target'],
  })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['ASC', 'DESC'] })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 100 })
  @ApiQuery({ name: 'offset', required: false, type: Number, example: 0 })
  @ApiResponse({
    status: 200,
    description: 'Audit log entries matching the filter.',
    schema: {
      example: {
        data: [
          {
            id: 'log-abc-123',
            adminId: 1,
            action: 'DELETE_CONFESSION',
            entityType: 'confession',
            entityId: 'f47ac10b-...',
            createdAt: '2026-04-25T10:00:00.000Z',
          },
        ],
        total: 1,
      },
    },
  })
  async getAuditLogs(
    @Query('adminId') adminId?: string,
    @Query('actor') actor?: string,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('requestId') requestId?: string,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: 'createdAt' | 'actor' | 'action' | 'target',
    @Query('sortOrder') sortOrder?: 'ASC' | 'DESC',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const result = await this.auditLogService.findAll({
      userId: adminId,
      actor,
      actionType: parseAuditAction(action),
      entityType,
      entityId,
      requestId,
      search,
      sortBy,
      sortOrder,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      // Issue #181: bounded page size so the response stays inside the
      // route's response budget.
      limit: Math.min(Math.max(parseInt(limit || '100', 10) || 100, 1), 500),
      offset: Math.max(parseInt(offset || '0', 10) || 0, 0),
    });

    return result;
  }

  @Get('observability')
  @ApiOperation({ summary: 'Get observability metrics for audit and notification health' })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    example: '2026-05-01',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    example: '2026-05-31',
  })
  @ApiResponse({
    status: 200,
    description: 'Aggregated observability metrics for admin review.',
  })
  async getObservability(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    return this.auditLogService.getObservabilityMetrics(start, end);
  }

  /**
   * Incident diagnostics bundle
   *
   * Assembles a time-bounded, redacted snapshot of system state suitable
   * for sharing with an incident responder.  The bundle includes:
   *   - Runtime meta (node version, uptime, env)
   *   - App version and git commit
   *   - Dependency reachability (database)
   *   - Applied / pending migrations
   *   - Recent queue action counts from audit logs
   *   - Recent error-class counts from audit logs
   *   - Non-sensitive config keys (all secrets redacted)
   *
   * Requires admin authentication.
   * Secrets, confession content, message bodies, and PII are NEVER included.
   *
   * @param windowMinutes  Lookback window in minutes for recent errors (default 30)
   */
  @Get('diagnostics/bundle')
  @RequireCapability(CAPABILITY_RUN_DIAGNOSTICS)
  @ApiOperation({
    summary: 'Generate incident diagnostics bundle',
    description:
      'Produces a redacted, time-bounded diagnostics snapshot. ' +
      'Safe to share with incident responders — no secrets or user content. ' +
      'Requires admin authentication.',
  })
  @ApiQuery({
    name: 'windowMinutes',
    required: false,
    type: Number,
    description: 'Error lookback window in minutes (default: 30)',
  })
  @ApiResponse({
    status: 200,
    description: 'Diagnostics bundle generated successfully',
  })
  async getDiagnosticsBundle(
    @Query('windowMinutes') windowMinutes?: string,
  ) {
    const window = windowMinutes
      ? Math.min(Math.max(parseInt(windowMinutes, 10) || 30, 1), 1440)
      : 30;
    return this.diagnosticsBundleService.build(window);
  }

  // Ranking quality drift (Issue #267)
  @Get('ranking/drift')
  @ApiOperation({
    summary: 'Get aggregate ranking quality drift indicators',
    description:
      'Returns minimum-cohort aggregate indicators only — no user-level histories ' +
      'are retained or exposed. Indicators below the minimum cohort size are ' +
      'suppressed and reported as insufficient data.',
  })
  @ApiQuery({
    name: 'rankingVersion',
    required: false,
    type: String,
    description: 'Ranking version to inspect (defaults to the active version)',
  })
  @ApiQuery({
    name: 'windowHours',
    required: false,
    type: Number,
    description: 'Aggregation window in hours (default: 24)',
  })
  @ApiResponse({
    status: 200,
    description: 'Aggregate drift indicators and threshold evaluation.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden — admin role required.' })
  async getRankingDrift(
    @Query('rankingVersion') rankingVersion?: string,
    @Query('windowHours') windowHours?: string,
  ) {
    const window = windowHours
      ? Math.min(Math.max(parseInt(windowHours, 10) || 24, 1), 168)
      : 24;
    return this.rankingDriftService.getDriftIndicators({
      rankingVersion,
      windowHours: window,
    });
  }

  @Post('ranking/:version/disable')
  @UseGuards(StepUpGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Disable a ranking version (kill switch)',
    description:
      'Disables the given ranking version via feature flag and records an audit ' +
      'entry. Requires step-up proof. Disabling an already-disabled version is ' +
      'idempotent.',
  })
  @ApiParam({ name: 'version', description: 'Ranking version identifier' })
  @ApiBody({
    schema: {
      example: {
        reason: 'Drift threshold breached: CTR drop of 18% over 24h.',
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Ranking version disabled.' })
  @ApiResponse({
    status: 403,
    description: 'Missing or expired step-up proof.',
  })
  @ApiResponse({ status: 404, description: 'Ranking version not found.' })
  async disableRankingVersion(
    @Param('version') version: string,
    @Body() body: { reason?: string },
    @GetUser('id') adminId: number,
    @Req() req: AuthedRequest,
  ) {
    return this.rankingDriftService.disableRankingVersion({
      version,
      adminId,
      reason: body?.reason || null,
      req,
    });
  }

  @Get('integrity/report')
  @RequireCapability(CAPABILITY_RUN_DIAGNOSTICS)
  @ApiOperation({
    summary: 'Generate cross-domain data integrity report',
    description:
      'Performs read-only bounded checks across identity, content, export, and moderation ' +
      'domains to detect invariant violations, orphan references, and data corruption.',
  })
  @ApiQuery({
    name: 'domains',
    required: false,
    description: 'Comma-separated domains to check: identity,content,export,moderation',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max sample violations per check (1-200, default 50)',
  })
  @ApiQuery({
    name: 'timeoutMs',
    required: false,
    description: 'Bounded execution time budget in ms (100-30000, default 5000)',
  })
  @ApiResponse({
    status: 200,
    description: 'Integrity report containing stable error codes and repair guidance.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin role required' })
  async getIntegrityReport(
    @Query('domains') domains?: string,
    @Query('limit') limit?: string,
    @Query('timeoutMs') timeoutMs?: string,
  ) {
    const parsedDomains = domains
      ? (domains
          .split(',')
          .map((d) => d.trim().toLowerCase())
          .filter((d) =>
            ['identity', 'content', 'export', 'moderation'].includes(d),
          ) as IntegrityDomain[])
      : undefined;

    return this.crossDomainIntegrityService.runIntegrityReport({
      domains: parsedDomains,
      limit: limit ? parseInt(limit, 10) : undefined,
      timeoutMs: timeoutMs ? parseInt(timeoutMs, 10) : undefined,
    });
  }
}
