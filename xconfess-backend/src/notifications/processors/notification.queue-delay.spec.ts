import {
  NotificationProcessor,
  NOTIFICATION_QUEUE,
  type NotificationJobData,
} from './notification.processor';
import { EmailNotificationService } from '../services/email-notification.service';
import { AppLogger } from '../../logger/logger.service';
import type { Job, Queue } from 'bullmq';

describe('NotificationProcessor queue delay metrics', () => {
  let processor: NotificationProcessor;
  let appLogger: { incrementCounter: jest.Mock; observeTimer: jest.Mock };

  beforeEach(() => {
    appLogger = {
      incrementCounter: jest.fn(),
      observeTimer: jest.fn(),
    };
    processor = new NotificationProcessor(
      {
        sendEmail: jest.fn().mockResolvedValue(undefined),
      } as unknown as EmailNotificationService,
      { add: jest.fn() } as unknown as Queue<NotificationJobData>,
      appLogger as unknown as AppLogger,
    );
  });

  it('measures queue wait from BullMQ enqueue and worker-start timestamps', async () => {
    const job = {
      name: 'send-notification',
      id: 'job-queue-wait',
      timestamp: 1000,
      processedOn: 1750,
      attemptsMade: 0,
      data: {
        userId: 'synthetic-user',
        type: 'test',
        title: 'Synthetic',
        message: 'Synthetic',
      },
      opts: {},
    } as unknown as Job<NotificationJobData>;

    await processor.process(job);

    expect(appLogger.observeTimer).toHaveBeenCalledWith(
      'notification_queue_wait_duration_ms',
      750,
      { queue: NOTIFICATION_QUEUE, jobName: job.name },
    );
  });

  it('counts queue wait observations with missing or invalid BullMQ timestamps', async () => {
    const job = {
      name: 'send-notification',
      id: 'job-missing-queue-time',
      timestamp: 2000,
      processedOn: 1000,
      attemptsMade: 0,
      data: {
        userId: 'synthetic-user',
        type: 'test',
        title: 'Synthetic',
        message: 'Synthetic',
      },
      opts: {},
    } as unknown as Job<NotificationJobData>;

    await processor.process(job);

    expect(appLogger.incrementCounter).toHaveBeenCalledWith(
      'notification_queue_wait_measurement_missing_total',
      1,
      { queue: NOTIFICATION_QUEUE, jobName: job.name },
    );
  });
});
