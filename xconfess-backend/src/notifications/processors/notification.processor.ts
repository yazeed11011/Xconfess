import { Processor, OnWorkerEvent, InjectQueue, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { EmailNotificationService } from '../services/email-notification.service';
import { NotificationType } from '../entities/notification.entity';
import { AppLogger } from '../../logger/logger.service';
import { QUEUE_WORKER_CONCURRENCY } from '../../config/queue-concurrency.config';

export const NOTIFICATION_QUEUE = 'notifications';
export const NOTIFICATION_DLQ = 'notifications-dlq';

export interface NotificationJobData {
  userId: string;
  type: string; // Unified with NotificationType or string
  title: string;
  message: string;
  metadata?: any;
  correlationId?: string;
  _meta?: {
    originalJobId: string | undefined;
    failedAt: string;
    attemptsMade: number;
    lastError: string;
    replayJobId?: string;
    replayedAt?: string;
    replayOutcome?: 'replayed' | 'deduplicated';
  };
}

@Processor(NOTIFICATION_QUEUE, {
  concurrency: QUEUE_WORKER_CONCURRENCY.notifications,
})
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private readonly emailNotificationService: EmailNotificationService,
    @InjectQueue(NOTIFICATION_DLQ)
    private readonly dlq: Queue<NotificationJobData>,
    private readonly appLogger: AppLogger,
  ) {
    super();
  }

  // ------------------------------------------------------------------ process
  async process(job: Job<NotificationJobData>): Promise<void> {
    if (job.name !== 'send-notification') {
      throw new Error(`Unsupported notification job name: ${job.name}`);
    }

    this.logger.log(
      `Processing notification job ${job.id} (attempt ${job.attemptsMade + 1})` +
        ` → userId: ${job.data.userId}`,
    );

    this.appLogger.incrementCounter('notification_queue_processing_total', 1, {
      queue: NOTIFICATION_QUEUE,
      jobName: job.name,
    });

    const enqueuedAtMs = job.timestamp;
    const startedAtMs = job.processedOn;
    if (
      typeof enqueuedAtMs === 'number' &&
      Number.isFinite(enqueuedAtMs) &&
      typeof startedAtMs === 'number' &&
      Number.isFinite(startedAtMs) &&
      startedAtMs >= enqueuedAtMs
    ) {
      this.appLogger.observeTimer(
        'notification_queue_wait_duration_ms',
        startedAtMs - enqueuedAtMs,
        {
          queue: NOTIFICATION_QUEUE,
          jobName: job.name,
        },
      );
    } else {
      this.appLogger.incrementCounter(
        'notification_queue_wait_measurement_missing_total',
        1,
        {
          queue: NOTIFICATION_QUEUE,
          jobName: job.name,
        },
      );
    }

    const startedAt = Date.now();
    await this.emailNotificationService.sendEmail(job.data);
    this.appLogger.observeTimer(
      'notification_queue_processing_duration_ms',
      Date.now() - startedAt,
      {
        queue: NOTIFICATION_QUEUE,
        jobName: job.name,
      },
    );
  }

  // --------------------------------------------------------------- on:failed
  /**
   * Called after every failed attempt.
   * When all attempts are exhausted BullMQ marks the job "failed" — we then
   * copy the full payload + error context into the dead-letter queue.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<NotificationJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const correlationId =
      job.data.correlationId ?? CorrelationContext.getOrGenerateRequestId();
    return CorrelationContext.run(correlationId, () =>
      this.handleFailed(job, error),
    );
  }

  private async handleFailed(
    job: Job<NotificationJobData>,
    error: Error,
  ): Promise<void> {

    const maxAttempts = (job.opts as any)?.attempts ?? 1;

    this.logger.warn(
      `Job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}): ${error.message}`,
    );

    const isExhausted = job.attemptsMade >= maxAttempts;

    if (!isExhausted) {
      this.appLogger.incrementCounter('notification_queue_retry_total', 1, {
        queue: NOTIFICATION_QUEUE,
        jobName: job.name,
        attempt: job.attemptsMade,
      });
    } else {
      this.appLogger.incrementCounter('notification_queue_failure_total', 1, {
        queue: NOTIFICATION_QUEUE,
        jobName: job.name,
      });
      this.appLogger.incrementCounter('notification_queue_dlq_total', 1, {
        queue: NOTIFICATION_QUEUE,
        jobName: job.name,
      });

      this.logger.error(
        `Job ${job.id} exhausted all retries — moving to DLQ`,
        error.stack,
      );

      await this.dlq.add(
        'dead-letter',
        {
          ...job.data,
          _meta: {
            originalJobId: String(job.id),
            failedAt: new Date().toISOString(),
            attemptsMade: job.attemptsMade,
            lastError: error.message,
          },
        },
        {
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
    }
  }

  // -------------------------------------------------------------- on:completed
  @OnWorkerEvent('completed')
  onCompleted(job: Job<NotificationJobData> | undefined): void {
    if (job) {
      this.logger.log(`Job ${job.id} completed successfully`);
    }
  }
}
