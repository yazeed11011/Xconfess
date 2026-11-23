import React, { useEffect, useState } from 'react';

interface QueueMetrics {
  pendingCount: number;
  unresolvedCount: number;
  oldestUnresolvedAgeSeconds: number | null;
  resolvedTodayCount: number;
  resolvedTodayWithinSlaCount: number;
  ageBuckets: {
    under15Minutes: number;
    under1Hour: number;
    under4Hours: number;
    over4Hours: number;
  };
  sla: {
    targetSeconds: number;
    attainedCount: number;
    breachedCount: number;
    attainmentPercent: number;
  };
  alertState: 'healthy' | 'warning' | 'critical';
  alertThresholds: {
    warningAgeSeconds: number;
    criticalAgeSeconds: number;
  };
  retention: {
    liveAggregateRetentionSeconds: number;
    policy: 'computed-on-demand';
  };
}

function hours(seconds: number): string {
  return `${Math.round((seconds / 3600) * 10) / 10}h`;
}

export default function ModerationQueueMetricsPage() {
  const [metrics, setMetrics] = useState<QueueMetrics | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let active = true;
    fetch('/api/admin/moderation/report-queue/stats')
      .then(async (response) => {
        if (!response.ok) throw new Error('moderation queue metrics unavailable');
        const body = await response.json();
        if (active) setMetrics(body);
      })
      .then(() => {
        if (active) setStatus('ready');
      })
      .catch(() => {
        if (active) setStatus('failed');
      });
    return () => {
      active = false;
    };
  }, []);

  if (status === 'loading') return <main aria-busy="true">Loading moderation queue metrics...</main>;
  if (status === 'failed') return <main role="alert">Moderation queue metrics unavailable. Retry later or verify admin access.</main>;
  if (!metrics) return null;

  return (
    <main>
      <h1>Moderation queue aging</h1>
      <p>Privacy-safe aggregate metrics. Reporter and subject identities are not included.</p>
      {metrics.alertState !== 'healthy' ? (
        <p role="alert">Queue alert: {metrics.alertState}. Oldest unresolved item exceeds {hours(metrics.alertThresholds[metrics.alertState === 'critical' ? 'criticalAgeSeconds' : 'warningAgeSeconds'])}.</p>
      ) : null}
      <section aria-label="Moderation queue counts">
        <h2>Queue health</h2>
        <p>Pending: {metrics.pendingCount}</p>
        <p>Unresolved: {metrics.unresolvedCount}</p>
        <p>Oldest unresolved: {metrics.oldestUnresolvedAgeSeconds === null ? 'none' : hours(metrics.oldestUnresolvedAgeSeconds)}</p>
        <p>SLA attainment: {metrics.sla.attainmentPercent}% ({metrics.sla.attainedCount} within target, {metrics.sla.breachedCount} breached)</p>
        <p>Resolved today: {metrics.resolvedTodayCount}; within SLA: {metrics.resolvedTodayWithinSlaCount}</p>
      </section>
      <section aria-label="Moderation queue age buckets">
        <h2>Age buckets</h2>
        <p>Under 15 minutes: {metrics.ageBuckets.under15Minutes}</p>
        <p>15 minutes to 1 hour: {metrics.ageBuckets.under1Hour}</p>
        <p>1 to 4 hours: {metrics.ageBuckets.under4Hours}</p>
        <p>Over 4 hours: {metrics.ageBuckets.over4Hours}</p>
      </section>
    </main>
  );
}
