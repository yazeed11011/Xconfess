/**
 * Named workload profiles for xConfess performance benchmarks.
 *
 * Each profile describes a realistic concurrency mix and documents the
 * dataset scale, request distribution, and intended test scenario.
 * Profiles are consumed by benchmark scripts and load tests to ensure
 * runs are comparable across branches.
 *
 * Profiles do NOT start servers or emit production data.
 *
 * See docs/performance-workload-profiles.md for runbook details.
 */

import { DatasetGenerator } from './dataset-generator';

/** Operation types that appear in workload distributions. */
export type WorkloadOperation =
  | 'GET /confessions'
  | 'GET /confessions/:id'
  | 'POST /confessions'
  | 'GET /reactions'
  | 'POST /reactions'
  | 'GET /confessions/search'
  | 'GET /confessions/trending'
  | 'POST /comments'
  | 'GET /notifications'
  | 'WS_CONNECT'
  | 'WS_DISCONNECT';

/** A single operation in the distribution table. */
export interface WorkloadEntry {
  operation: WorkloadOperation;
  /** Weight relative to other entries; higher = more frequent. */
  weight: number;
  /** Human-readable note on why this weight was chosen. */
  rationale: string;
}

/** Full description of a workload profile. */
export interface WorkloadProfile {
  /** Unique stable identifier for the profile. */
  name: string;
  /** One-line purpose. */
  description: string;
  /**
   * Number of concurrent virtual users simulated in the steady state.
   * Actual concurrency is controlled by the load-test driver; this is
   * documentation only.
   */
  concurrentUsers: number;
  /** Target total RPS in the steady state (documentation only). */
  targetRps: number;
  /** Seed used by DatasetGenerator to produce reproducible fixtures. */
  datasetSeed: number;
  /** Dataset sizes used by this profile. */
  datasetScale: {
    users: number;
    confessions: number;
    reactions: number;
    comments: number;
    notificationJobs: number;
  };
  /**
   * Weighted distribution of HTTP/WS operations.
   * Weights are normalised internally; they do not need to sum to 100.
   */
  distribution: WorkloadEntry[];
}

// ── Profile definitions ──────────────────────────────────────────────────────

/**
 * Smoke profile — minimal footprint, fast CI sanity check.
 * Validates p50 baselines without extended warm-up.
 */
export const SMOKE_PROFILE: WorkloadProfile = {
  name: 'smoke',
  description:
    'Minimal concurrency check — validates p50 baselines in under 30 s',
  concurrentUsers: 5,
  targetRps: 20,
  datasetSeed: 1,
  datasetScale: {
    users: 10,
    confessions: 50,
    reactions: 100,
    comments: 50,
    notificationJobs: 20,
  },
  distribution: [
    {
      operation: 'GET /confessions',
      weight: 40,
      rationale: 'Public feed is the most common read',
    },
    {
      operation: 'GET /confessions/:id',
      weight: 25,
      rationale: 'Detail view after clicking a feed item',
    },
    {
      operation: 'GET /reactions',
      weight: 15,
      rationale: 'Reactions co-loaded with confession detail',
    },
    {
      operation: 'POST /confessions',
      weight: 10,
      rationale: 'Low write ratio in read-heavy feed',
    },
    {
      operation: 'POST /reactions',
      weight: 10,
      rationale: 'Quick reaction taps',
    },
  ],
};

/**
 * Read-heavy profile — models typical daytime traffic.
 * ~80 % reads / 20 % writes, moderate concurrency.
 */
export const READ_HEAVY_PROFILE: WorkloadProfile = {
  name: 'read-heavy',
  description: 'Typical daytime traffic — 80 % reads, 20 % writes at 100 VU',
  concurrentUsers: 100,
  targetRps: 300,
  datasetSeed: 42,
  datasetScale: {
    users: 500,
    confessions: 5000,
    reactions: 25000,
    comments: 10000,
    notificationJobs: 2000,
  },
  distribution: [
    {
      operation: 'GET /confessions',
      weight: 35,
      rationale: 'Feed browsing dominates',
    },
    {
      operation: 'GET /confessions/:id',
      weight: 20,
      rationale: 'Detail views',
    },
    {
      operation: 'GET /confessions/trending',
      weight: 10,
      rationale: 'Trending tab is frequently hit',
    },
    {
      operation: 'GET /confessions/search',
      weight: 10,
      rationale: 'Search queries',
    },
    {
      operation: 'GET /reactions',
      weight: 10,
      rationale: 'Reaction counts loaded per confession',
    },
    {
      operation: 'GET /notifications',
      weight: 5,
      rationale: 'Authenticated users poll notifications',
    },
    {
      operation: 'POST /confessions',
      weight: 5,
      rationale: 'Write traffic is small relative to reads',
    },
    {
      operation: 'POST /reactions',
      weight: 3,
      rationale: 'Reaction writes',
    },
    {
      operation: 'POST /comments',
      weight: 2,
      rationale: 'Comment writes',
    },
  ],
};

/**
 * Write-spike profile — models a viral event where many users post at once.
 * Tests DB write throughput and queue back-pressure.
 */
export const WRITE_SPIKE_PROFILE: WorkloadProfile = {
  name: 'write-spike',
  description:
    'Viral event simulation — elevated write ratio with queue back-pressure',
  concurrentUsers: 200,
  targetRps: 500,
  datasetSeed: 99,
  datasetScale: {
    users: 1000,
    confessions: 2000,
    reactions: 8000,
    comments: 4000,
    notificationJobs: 5000,
  },
  distribution: [
    {
      operation: 'POST /confessions',
      weight: 30,
      rationale: 'Viral burst — many new confessions',
    },
    {
      operation: 'POST /reactions',
      weight: 25,
      rationale: 'Reaction spike on new content',
    },
    {
      operation: 'POST /comments',
      weight: 15,
      rationale: 'Elevated comment activity',
    },
    {
      operation: 'GET /confessions',
      weight: 20,
      rationale: 'Readers following the surge',
    },
    {
      operation: 'WS_CONNECT',
      weight: 5,
      rationale: 'New WebSocket connections during spike',
    },
    {
      operation: 'GET /confessions/:id',
      weight: 5,
      rationale: 'Viral confessions receive direct link traffic',
    },
  ],
};

export interface NotificationBurstProfile {
  name: string;
  sourceProfile: string;
  submissions: number;
  uniqueNotifications: number;
  burstDurationMs: number;
  producerConcurrency: number;
  targetRps: number;
  workerConcurrency: number;
  processingTimeMs: number;
  queueDelayP95BudgetMs: number;
  databaseOperationsPerSubmissionBudget: number;
}

/**
 * Notification queue burst layered onto the write-spike workload. Five
 * submissions per synthetic source event exercise idempotency under fan-in.
 */
export const NOTIFICATION_BURST_PROFILE: NotificationBurstProfile = {
  name: 'notification-burst',
  sourceProfile: WRITE_SPIKE_PROFILE.name,
  submissions: WRITE_SPIKE_PROFILE.datasetScale.notificationJobs,
  uniqueNotifications: 1000,
  burstDurationMs: 10_000,
  producerConcurrency: WRITE_SPIKE_PROFILE.concurrentUsers,
  targetRps: WRITE_SPIKE_PROFILE.targetRps,
  workerConcurrency: 5,
  processingTimeMs: 75,
  queueDelayP95BudgetMs: 6000,
  databaseOperationsPerSubmissionBudget: 6,
};

/**
 * WebSocket soak profile — long-lived connections for memory leak detection.
 * Tests unbounded heap growth under sustained connection load.
 */
export const WS_SOAK_PROFILE: WorkloadProfile = {
  name: 'ws-soak',
  description:
    'Long-lived WS connections — validates bounded memory over 10 min',
  concurrentUsers: 500,
  targetRps: 50, // Low HTTP; most load is WS
  datasetSeed: 7,
  datasetScale: {
    users: 500,
    confessions: 1000,
    reactions: 2000,
    comments: 500,
    notificationJobs: 10000, // Large job volume to test queue GC
  },
  distribution: [
    {
      operation: 'WS_CONNECT',
      weight: 40,
      rationale: 'Establish and hold 500 simultaneous connections',
    },
    {
      operation: 'WS_DISCONNECT',
      weight: 10,
      rationale: 'Churn ~20 % of connections to test cleanup',
    },
    {
      operation: 'GET /confessions',
      weight: 30,
      rationale: 'Background HTTP reads alongside WS connections',
    },
    {
      operation: 'GET /notifications',
      weight: 20,
      rationale: 'Notification polling for authenticated users',
    },
  ],
};

/** All built-in profiles in a single lookup map. */
export const WORKLOAD_PROFILES: Record<string, WorkloadProfile> = {
  [SMOKE_PROFILE.name]: SMOKE_PROFILE,
  [READ_HEAVY_PROFILE.name]: READ_HEAVY_PROFILE,
  [WRITE_SPIKE_PROFILE.name]: WRITE_SPIKE_PROFILE,
  [WS_SOAK_PROFILE.name]: WS_SOAK_PROFILE,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalise a distribution so weights sum to 1.0.
 */
export function normaliseDistribution(
  dist: WorkloadEntry[],
): Array<WorkloadEntry & { normalisedWeight: number }> {
  const total = dist.reduce((sum, e) => sum + e.weight, 0);
  if (total === 0) return dist.map((e) => ({ ...e, normalisedWeight: 0 }));
  return dist.map((e) => ({ ...e, normalisedWeight: e.weight / total }));
}

/**
 * Build the full dataset for a given profile and return it together with
 * the profile descriptor. The generator is seeded from the profile so
 * fixtures are always identical for the same profile.
 */
export function buildProfileDataset(profile: WorkloadProfile) {
  const gen = new DatasetGenerator(profile.datasetSeed);
  const users = gen.users(profile.datasetScale.users);
  const confessions = gen.confessions(
    profile.datasetScale.confessions,
    users,
  );
  const reactions = gen.reactions(
    profile.datasetScale.reactions,
    confessions,
    users,
  );
  const comments = gen.comments(
    profile.datasetScale.comments,
    confessions,
    users,
  );
  const notificationJobs = gen.notificationJobs(
    profile.datasetScale.notificationJobs,
    users,
  );

  return { profile, users, confessions, reactions, comments, notificationJobs };
}
