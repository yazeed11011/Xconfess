import { NOTIFICATION_BURST_PROFILE } from './workload-profiles';
import type { NotificationBurstProfile } from './workload-profiles';

export interface NotificationBurstSubmission {
  sourceEventId: string;
  enqueuedAtMs: number;
}

export interface NotificationQueueMeasurements {
  submissions: number;
  uniqueJobs: number;
  duplicatesSuppressed: number;
  queueDelayP50Ms: number;
  queueDelayP95Ms: number;
  maxQueueDelayMs: number;
}

function validateProfile(profile: NotificationBurstProfile): void {
  const positiveIntegers = [
    profile.submissions,
    profile.uniqueNotifications,
    profile.producerConcurrency,
    profile.targetRps,
    profile.workerConcurrency,
  ];

  if (
    !profile.name.trim() ||
    !profile.sourceProfile.trim() ||
    positiveIntegers.some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    ) ||
    profile.uniqueNotifications > profile.submissions ||
    profile.producerConcurrency > profile.submissions ||
    !Number.isFinite(profile.burstDurationMs) ||
    profile.burstDurationMs <= 0 ||
    Math.abs(
      profile.burstDurationMs -
        (profile.submissions * 1000) / profile.targetRps,
    ) > 0.001 ||
    !Number.isFinite(profile.processingTimeMs) ||
    profile.processingTimeMs <= 0 ||
    !Number.isFinite(profile.queueDelayP95BudgetMs) ||
    profile.queueDelayP95BudgetMs <= 0 ||
    !Number.isSafeInteger(profile.databaseOperationsPerSubmissionBudget) ||
    profile.databaseOperationsPerSubmissionBudget <= 0
  ) {
    throw new RangeError('Invalid notification burst profile');
  }
}

/** Creates deterministic, content-free submissions for the burst profile. */
export function buildNotificationBurstSubmissions(
  profile: NotificationBurstProfile = NOTIFICATION_BURST_PROFILE,
): NotificationBurstSubmission[] {
  validateProfile(profile);

  return Array.from({ length: profile.submissions }, (_, index) => ({
    sourceEventId: `synthetic-event-${Math.floor(
      (index * profile.uniqueNotifications) / profile.submissions,
    )}`,
    enqueuedAtMs: (index * profile.burstDurationMs) / profile.submissions,
  }));
}

/**
 * Models queue waiting with fixed processing time and worker concurrency. This
 * is a deterministic capacity check, not a substitute for live Redis timings.
 */
export function measureNotificationQueue(
  profile: NotificationBurstProfile = NOTIFICATION_BURST_PROFILE,
): NotificationQueueMeasurements {
  validateProfile(profile);

  const submissions = buildNotificationBurstSubmissions(profile);
  const uniqueArrivals = new Map<string, number>();
  for (const submission of submissions) {
    if (!uniqueArrivals.has(submission.sourceEventId)) {
      uniqueArrivals.set(submission.sourceEventId, submission.enqueuedAtMs);
    }
  }

  const workerAvailableAt = Array<number>(profile.workerConcurrency).fill(0);
  const delays: number[] = [];

  for (const enqueuedAtMs of uniqueArrivals.values()) {
    let workerIndex = 0;
    for (let index = 1; index < workerAvailableAt.length; index += 1) {
      if (workerAvailableAt[index] < workerAvailableAt[workerIndex]) {
        workerIndex = index;
      }
    }

    const startedAtMs = Math.max(
      enqueuedAtMs,
      workerAvailableAt[workerIndex],
    );
    delays.push(startedAtMs - enqueuedAtMs);
    workerAvailableAt[workerIndex] =
      startedAtMs + profile.processingTimeMs;
  }

  delays.sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    delays[Math.ceil(delays.length * fraction) - 1] ?? 0;

  return {
    submissions: profile.submissions,
    uniqueJobs: uniqueArrivals.size,
    duplicatesSuppressed: profile.submissions - uniqueArrivals.size,
    queueDelayP50Ms: percentile(0.5),
    queueDelayP95Ms: percentile(0.95),
    maxQueueDelayMs: delays[delays.length - 1] ?? 0,
  };
}
