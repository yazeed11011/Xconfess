import {
  buildNotificationBurstSubmissions,
  measureNotificationQueue,
} from '../notification-burst';
import { NOTIFICATION_BURST_PROFILE } from '../workload-profiles';

describe('notification burst profile', () => {
  it('generates reproducible synthetic events at the configured burst rate', () => {
    const submissions = buildNotificationBurstSubmissions();

    expect(submissions).toHaveLength(
      NOTIFICATION_BURST_PROFILE.submissions,
    );
    expect(submissions[0]).toEqual({
      sourceEventId: 'synthetic-event-0',
      enqueuedAtMs: 0,
    });
    expect(submissions.at(-1)?.enqueuedAtMs).toBeLessThan(
      NOTIFICATION_BURST_PROFILE.burstDurationMs,
    );
    expect(
      new Set(submissions.map((submission) => submission.sourceEventId)).size,
    ).toBe(NOTIFICATION_BURST_PROFILE.uniqueNotifications);
    expect(
      submissions.some((submission) =>
        /@|[A-Z][a-z]+ [A-Z][a-z]+/.test(submission.sourceEventId),
      ),
    ).toBe(false);
  });

  it('measures queue wait and duplicate suppression against published thresholds', () => {
    const measurements = measureNotificationQueue();

    expect(measurements.submissions).toBe(5000);
    expect(measurements.uniqueJobs).toBe(1000);
    expect(measurements.duplicatesSuppressed).toBe(4000);
    expect(measurements.queueDelayP95Ms).toBeLessThanOrEqual(
      NOTIFICATION_BURST_PROFILE.queueDelayP95BudgetMs,
    );
  });

  it('rejects invalid burst profiles rather than reporting false measurements', () => {
    expect(() =>
      buildNotificationBurstSubmissions({
        ...NOTIFICATION_BURST_PROFILE,
        uniqueNotifications: NOTIFICATION_BURST_PROFILE.submissions + 1,
      }),
    ).toThrow('Invalid notification burst profile');
  });
});
