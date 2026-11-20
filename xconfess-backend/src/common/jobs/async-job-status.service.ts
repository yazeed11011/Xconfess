import { Injectable } from '@nestjs/common';
import {
  AsyncJobState,
  AsyncJobStatusResponseDto,
  ErrorCategory,
  RetryGuidance,
} from './async-job-status.dto';

export interface BuildJobStatusParams<T = Record<string, any>> {
  jobId: string;
  jobType: string;
  status: AsyncJobState;
  progress?: number;
  createdAt: Date | string | number;
  startedAt?: Date | string | number;
  completedAt?: Date | string | number;
  attemptsMade?: number;
  maxAttempts?: number;
  error?: { message: string; code?: string; isTransient?: boolean };
  metadata?: T;
}

@Injectable()
export class AsyncJobStatusService {
  private readonly contractVersion = '2026-11-20';

  private toIsoString(date?: Date | string | number): string | undefined {
    if (!date) return undefined;
    if (date instanceof Date) return date.toISOString();
    if (typeof date === 'number') return new Date(date).toISOString();
    return new Date(date).toISOString();
  }

  buildStatusResponse<T = Record<string, any>>(
    params: BuildJobStatusParams<T>,
  ): AsyncJobStatusResponseDto<T> {
    const attemptsMade = params.attemptsMade ?? 0;
    const maxRetries = (params.maxAttempts ?? 3) - 1;

    let retryable = false;
    let errorCategory: ErrorCategory | undefined;
    let retryAfterSeconds: number | undefined;

    if (params.status === AsyncJobState.FAILED) {
      if (params.error?.isTransient !== false && attemptsMade <= maxRetries) {
        retryable = true;
        errorCategory = ErrorCategory.TRANSIENT;
        // Exponential backoff recommendation: 5s, 15s, 60s
        const backoffSeconds = [5, 15, 60, 300];
        retryAfterSeconds = backoffSeconds[attemptsMade - 1] || 60;
      } else {
        retryable = false;
        errorCategory = ErrorCategory.PERMANENT;
      }
    } else if (params.status === AsyncJobState.CANCELLED) {
      retryable = false;
      errorCategory = ErrorCategory.USER_CANCELLED;
    }

    const retryGuidance: RetryGuidance = {
      retryable,
      retryAfterSeconds,
      maxRetries,
      attemptsMade,
      errorCategory,
    };

    return {
      version: this.contractVersion,
      jobId: params.jobId,
      jobType: params.jobType,
      status: params.status,
      progress: Math.min(100, Math.max(0, params.progress ?? 0)),
      createdAt: this.toIsoString(params.createdAt) || new Date().toISOString(),
      startedAt: this.toIsoString(params.startedAt),
      completedAt: this.toIsoString(params.completedAt),
      retryGuidance,
      resultMetadata: params.metadata,
      error: params.error
        ? {
            code: params.error.code || 'JOB_EXECUTION_ERROR',
            message: params.error.message,
            category: errorCategory || ErrorCategory.PERMANENT,
          }
        : undefined,
    };
  }
}
