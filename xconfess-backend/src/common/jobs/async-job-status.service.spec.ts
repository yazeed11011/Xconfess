import { AsyncJobStatusService } from './async-job-status.service';
import { AsyncJobState, ErrorCategory } from './async-job-status.dto';

describe('AsyncJobStatusService', () => {
  let service: AsyncJobStatusService;

  beforeEach(() => {
    service = new AsyncJobStatusService();
  });

  it('should format queued and running job responses with contract version', () => {
    const res = service.buildStatusResponse({
      jobId: 'job-123',
      jobType: 'data-export',
      status: AsyncJobState.RUNNING,
      progress: 45,
      createdAt: new Date('2026-11-20T10:00:00Z'),
      startedAt: new Date('2026-11-20T10:01:00Z'),
    });

    expect(res.version).toBe('2026-11-20');
    expect(res.jobId).toBe('job-123');
    expect(res.status).toBe(AsyncJobState.RUNNING);
    expect(res.progress).toBe(45);
    expect(res.retryGuidance.retryable).toBe(false);
  });

  it('should compute safe retry guidance for transient job failures', () => {
    const res = service.buildStatusResponse({
      jobId: 'job-456',
      jobType: 'notification-digest',
      status: AsyncJobState.FAILED,
      createdAt: new Date(),
      attemptsMade: 1,
      maxAttempts: 3,
      error: { message: 'Database query timeout', isTransient: true },
    });

    expect(res.status).toBe(AsyncJobState.FAILED);
    expect(res.retryGuidance.retryable).toBe(true);
    expect(res.retryGuidance.errorCategory).toBe(ErrorCategory.TRANSIENT);
    expect(res.retryGuidance.retryAfterSeconds).toBe(5);
  });

  it('should mark cancelled jobs with USER_CANCELLED error category and no retry', () => {
    const res = service.buildStatusResponse({
      jobId: 'job-789',
      jobType: 'data-export',
      status: AsyncJobState.CANCELLED,
      createdAt: new Date(),
    });

    expect(res.status).toBe(AsyncJobState.CANCELLED);
    expect(res.retryGuidance.retryable).toBe(false);
    expect(res.retryGuidance.errorCategory).toBe(ErrorCategory.USER_CANCELLED);
  });
});
