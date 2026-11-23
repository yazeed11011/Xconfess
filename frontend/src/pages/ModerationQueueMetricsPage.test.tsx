// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModerationQueueMetricsPage from './ModerationQueueMetricsPage';

describe('ModerationQueueMetricsPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders aggregate aging and SLA metrics without identifiers', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        pendingCount: 2,
        unresolvedCount: 3,
        oldestUnresolvedAgeSeconds: 18000,
        resolvedTodayCount: 4,
        resolvedTodayWithinSlaCount: 3,
        ageBuckets: {
          under15Minutes: 1,
          under1Hour: 1,
          under4Hours: 0,
          over4Hours: 1,
        },
        sla: {
          targetSeconds: 14400,
          attainedCount: 2,
          breachedCount: 1,
          attainmentPercent: 66.67,
        },
        alertState: 'warning',
        alertThresholds: {
          warningAgeSeconds: 3600,
          criticalAgeSeconds: 14400,
        },
        retention: {
          liveAggregateRetentionSeconds: 2592000,
          policy: 'computed-on-demand',
        },
      }),
    } as Response);

    render(<ModerationQueueMetricsPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Moderation queue aging' })).toBeTruthy();
    });
    expect(screen.getByText(/SLA attainment: 66.67%/)).toBeTruthy();
    expect(screen.getByText(/Over 4 hours: 1/)).toBeTruthy();
    expect(screen.queryByText(/reporterId|anonymousReporterId|confessionId/i)).toBeNull();
  });

  it('shows an explicit retryable failure state', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);

    render(<ModerationQueueMetricsPage />);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Moderation queue metrics unavailable',
    );
  });
});
