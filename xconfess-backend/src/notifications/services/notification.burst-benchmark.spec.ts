import { NotificationService } from './notification.service';
import {
  Notification,
  NotificationType,
} from '../entities/notification.entity';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { User } from '../../user/entities/user.entity';
import type { Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import { AppLogger } from '../../logger/logger.service';
import { ConfigService } from '@nestjs/config';
import {
  buildNotificationBurstSubmissions,
  measureNotificationQueue,
} from '../../common/performance/notification-burst';
import { NOTIFICATION_BURST_PROFILE } from '../../common/performance/workload-profiles';

describe('notification write-spike burst benchmark', () => {
  it('measures queue delay, repository load, and duplicate suppression', async () => {
    const storedBySourceKey = new Map<string, Notification>();
    const database = {
      preferenceReads: 0,
      userReads: 0,
      notificationReads: 0,
      insertAttempts: 0,
      uniqueInsertConflicts: 0,
      successfulInserts: 0,
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const metricCounters = new Map<string, number>();
    const logger = {
      incrementCounter: jest.fn((name: string, value = 1) => {
        metricCounters.set(name, (metricCounters.get(name) ?? 0) + value);
      }),
      warn: jest.fn(),
    };
    const preference = {
      userId: 'synthetic-user',
      enableInAppNotifications: true,
      inAppNewMessage: true,
      enableEmailNotifications: true,
      emailAddress: 'synthetic@example.invalid',
      emailNewMessage: true,
      enableQuietHours: false,
    };
    const preferenceRepository = {
      findOne: jest.fn(async () => {
        database.preferenceReads += 1;
        return preference;
      }),
    };
    const userRepository = {
      findOne: jest.fn(async () => {
        database.userReads += 1;
        return null;
      }),
    };
    const notificationRepository = {
      findOne: jest.fn(async (options: { where: { sourceKey: string } }) => {
        database.notificationReads += 1;
        return storedBySourceKey.get(options.where.sourceKey) ?? null;
      }),
      create: jest.fn((input: Partial<Notification>) => input),
      save: jest.fn(async (input: Partial<Notification>) => {
        database.insertAttempts += 1;
        const sourceKey = input.sourceKey;
        if (!sourceKey) {
          throw new Error('Synthetic notification is missing its source key');
        }
        if (storedBySourceKey.has(sourceKey)) {
          database.uniqueInsertConflicts += 1;
          throw { code: '23505' };
        }

        const saved = {
          ...input,
          id: `synthetic-notification-${database.successfulInserts + 1}`,
        } as Notification;
        storedBySourceKey.set(sourceKey, saved);
        database.successfulInserts += 1;
        return saved;
      }),
    };
    const service = new NotificationService(
      notificationRepository as unknown as Repository<Notification>,
      preferenceRepository as unknown as Repository<NotificationPreference>,
      userRepository as unknown as Repository<User>,
      queue as unknown as Queue,
      logger as unknown as AppLogger,
      { get: jest.fn(() => 'true') } as unknown as ConfigService,
    );

    const submissions = buildNotificationBurstSubmissions();
    for (
      let offset = 0;
      offset < submissions.length;
      offset += NOTIFICATION_BURST_PROFILE.producerConcurrency
    ) {
      const batch = submissions.slice(
        offset,
        offset + NOTIFICATION_BURST_PROFILE.producerConcurrency,
      );
      await Promise.all(
        batch.map((submission) =>
          service.createNotification({
            userId: 'synthetic-user',
            type: NotificationType.NEW_MESSAGE,
            title: 'Synthetic notification',
            message: 'Synthetic benchmark content only',
            metadata: { sourceEventId: submission.sourceEventId },
          }),
        ),
      );
    }

    const queueMeasurements = measureNotificationQueue();
    const databaseOperations =
      database.preferenceReads +
      database.userReads +
      database.notificationReads +
      database.insertAttempts;
    const suppressedDuplicates =
      metricCounters.get('notification_duplicate_suppressed_total') ?? 0;
    console.info(
      '[notification-burst]',
      JSON.stringify({
        profile: NOTIFICATION_BURST_PROFILE.name,
        submissions: submissions.length,
        uniqueNotifications: storedBySourceKey.size,
        duplicatesSuppressed: suppressedDuplicates,
        queueDelayModel: queueMeasurements,
        databaseOperations: {
          total: databaseOperations,
          perSubmission:
            databaseOperations / NOTIFICATION_BURST_PROFILE.submissions,
          preferencesRead: database.preferenceReads,
          usersRead: database.userReads,
          notificationReads: database.notificationReads,
          insertAttempts: database.insertAttempts,
          successfulInserts: database.successfulInserts,
          uniqueInsertConflicts: database.uniqueInsertConflicts,
        },
        thresholds: {
          queueDelayP95Ms:
            NOTIFICATION_BURST_PROFILE.queueDelayP95BudgetMs,
          databaseOperationsPerSubmission:
            NOTIFICATION_BURST_PROFILE.databaseOperationsPerSubmissionBudget,
        },
      }),
    );

    expect(storedBySourceKey.size).toBe(
      NOTIFICATION_BURST_PROFILE.uniqueNotifications,
    );
    expect(database.successfulInserts).toBe(
      NOTIFICATION_BURST_PROFILE.uniqueNotifications,
    );
    expect(suppressedDuplicates).toBe(
      NOTIFICATION_BURST_PROFILE.submissions -
        NOTIFICATION_BURST_PROFILE.uniqueNotifications,
    );
    expect(queue.add).toHaveBeenCalledTimes(
      NOTIFICATION_BURST_PROFILE.uniqueNotifications,
    );
    expect(
      databaseOperations / NOTIFICATION_BURST_PROFILE.submissions,
    ).toBeLessThanOrEqual(
      NOTIFICATION_BURST_PROFILE.databaseOperationsPerSubmissionBudget,
    );
    expect(queueMeasurements.queueDelayP95Ms).toBeLessThanOrEqual(
      NOTIFICATION_BURST_PROFILE.queueDelayP95BudgetMs,
    );
    expect(database.uniqueInsertConflicts).toBeLessThanOrEqual(
      NOTIFICATION_BURST_PROFILE.submissions -
        NOTIFICATION_BURST_PROFILE.uniqueNotifications,
    );
  });
});
