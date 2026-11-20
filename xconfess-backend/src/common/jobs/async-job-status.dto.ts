export enum AsyncJobState {
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum ErrorCategory {
  TRANSIENT = 'TRANSIENT',
  PERMANENT = 'PERMANENT',
  RATE_LIMITED = 'RATE_LIMITED',
  USER_CANCELLED = 'USER_CANCELLED',
}

export interface RetryGuidance {
  retryable: boolean;
  retryAfterSeconds?: number;
  maxRetries: number;
  attemptsMade: number;
  errorCategory?: ErrorCategory;
}

export interface AsyncJobStatusResponseDto<T = Record<string, any>> {
  version: string; // e.g. "2026-11-20"
  jobId: string;
  jobType: string;
  status: AsyncJobState;
  progress: number; // 0 to 100
  createdAt: string; // ISO 8601
  startedAt?: string;
  completedAt?: string;
  retryGuidance: RetryGuidance;
  resultMetadata?: T;
  error?: {
    code: string;
    message: string;
    category: ErrorCategory;
  };
}
