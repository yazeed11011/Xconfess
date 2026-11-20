# Asynchronous Job Contracts, Media Derivatives, Notification Digests, and Cancellation Propagation

This document specifies the capabilities implemented for issues #384, #388, #389, and #394.

---

## 1. Stable Response Contract for Asynchronous Job Status (#384)

### Overview
Unifies asynchronous job status reporting across exports, notification tasks, and media processing with standard schema versioning and safe client retry guidance.

### Response Contract Shape
```json
{
  "version": "2026-11-20",
  "jobId": "export-uuid-123",
  "jobType": "data-export",
  "status": "running",
  "progress": 65,
  "createdAt": "2026-11-20T10:00:00.000Z",
  "startedAt": "2026-11-20T10:01:00.000Z",
  "completedAt": null,
  "retryGuidance": {
    "retryable": false,
    "retryAfterSeconds": null,
    "maxRetries": 3,
    "attemptsMade": 0,
    "errorCategory": null
  },
  "resultMetadata": {
    "recordCount": 150,
    "isChunked": false
  }
}
```

### Retry Guidance Semantics
- **Transient Failures (`TRANSIENT`)**: Network timeouts, database lock contentions. `retryable: true` with exponential `retryAfterSeconds`.
- **Permanent Failures (`PERMANENT`)**: Data corruption, malformed input. `retryable: false`.
- **User Cancellations (`USER_CANCELLED`)**: Explicit aborts. `retryable: false`.

---

## 2. Bounded Media Thumbnail Generation Background Jobs (#388)

### Overview
Generates approved image derivatives asynchronously with strict input validation, bounded output limits, idempotent deduplication, artifact cleanup, and access control.

### Boundaries & Constraints
- **Allowed MIME types**: `image/jpeg`, `image/png`, `image/webp`
- **Max original file size**: 15 MB
- **Thumbnail dimension bounds**: 32x32 to 640x640 (standard: 320x320)
- **Max derivative size**: 250 KB
- **Idempotency**: Computes `idempotentKey = SHA256(originalFileKey + ":" + width + ":" + height + ":" + format)`. Duplicate requests return the existing job.
- **Artifact Cleanup**: Failed jobs immediately scrub temporary artifacts from storage.
- **Authorization**: Access to original files and generated derivatives is strictly limited to the content owner or moderators.

---

## 3. Account-Scoped Notification Digests (#389)

### Overview
Aggregates asynchronous platform notifications into time-windowed digests (daily or weekly) while honoring user quiet hours, privacy controls, per-event redactions, and deduplication.

### Governance & Privacy Semantics
- **Worker Deduplication**: Identifiers follow `digest:<userId>:<windowStart>:<windowEnd>` ensuring workers never dispatch duplicate digests upon retry.
- **Quiet Hours**: Respects user timezone. If current time is between 22:00 and 08:00, digest status is set to `DEFERRED`.
- **Privacy Enforcement**: Honors `privacy_settings.enableEmailDigests`. If disabled, marks as `SUPPRESSED_PRIVACY`.
- **Per-Event Redaction**: Truncates confession text to 60 characters with ellipsis, masks participant emails/IDs as "Anonymous Member", and excludes soft-deleted or rejected confessions.

---

## 4. Standardized Cancellation Propagation (#394)

### Overview
Propagates client disconnects and deadline cancellations from frontend proxy routes down to backend asynchronous operations.

### Architecture
1. **Frontend Proxy Integration**: `proxyRequestWithResponse` in `proxy.ts` and Next.js route handlers link `request.signal` (incoming HTTP request signal) to downstream backend fetch requests.
2. **Backend Lifecycle Guard**: `RequestCancellationMiddleware` binds an `AbortController` to the ambient `CancellationContext` per request.
3. **Early Abort**: If the user disconnects or navigates away before response completion, `res.on('close')` fires and aborts downstream database queries and compute operations.
