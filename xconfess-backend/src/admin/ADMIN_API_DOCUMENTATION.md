# Admin API Documentation

## Overview
The Admin API provides endpoints for moderators to manage reports, confessions, users, and view platform analytics. All endpoints require admin authentication.

## Authentication
All admin endpoints require:
- Valid JWT token in `Authorization: Bearer <token>` header
- User must have `isAdmin: true` in their user record

## Endpoints

### Reports

#### GET /api/admin/reports
List all reports with filtering options.

**Query Parameters:**
- `status` (optional): Filter by status (`pending`, `reviewing`, `resolved`, `dismissed`)
- `type` (optional): Filter by type (`spam`, `harassment`, `hate_speech`, `inappropriate_content`, `copyright`, `other`)
- `startDate` (optional): Filter reports created after this date (ISO string)
- `endDate` (optional): Filter reports created before this date (ISO string)
- `limit` (optional, default: 50): Number of results per page
- `offset` (optional, default: 0): Pagination offset

**Response:**
```json
{
  "reports": [...],
  "total": 100,
  "limit": 50,
  "offset": 0
}
```

#### GET /api/admin/reports/:id
Get a specific report by ID.

**Response:**
```json
{
  "id": "uuid",
  "confessionId": "uuid",
  "type": "spam",
  "status": "pending",
  "reason": "...",
  "createdAt": "2024-01-01T00:00:00Z",
  ...
}
```

#### PATCH /api/admin/reports/:id/resolve
Resolve a report.

**Body:**
```json
{
  "resolutionNotes": "Optional notes about the resolution"
}
```

#### PATCH /api/admin/reports/:id/dismiss
Dismiss a report.

**Body:**
```json
{
  "resolutionNotes": "Optional notes about why it was dismissed"
}
```

#### PATCH /api/admin/reports/bulk-resolve
Resolve multiple reports at once.

**Body:**
```json
{
  "reportIds": ["uuid1", "uuid2", ...],
  "notes": "Optional notes"
}
```

#### POST /api/admin/reports/bulk-resolve/preview
Preview a bulk-resolve without applying any changes. Returns the exact target set and
per-report consequence. The `previewId` expires in 10 minutes and must be passed to the
commit endpoint. Requires the same `CAPABILITY_MODERATE_CONTENT` capability and an active
moderation access grant.

**Body:**
```json
{
  "reportIds": ["uuid1", "uuid2"],
  "notes": "Optional notes (stored and applied at commit time)"
}
```

**Response (201):**
```json
{
  "previewId": "uuid",
  "expiresAt": "2024-01-01T00:10:00Z",
  "total": 2,
  "eligible": 1,
  "records": [
    {
      "reportId": "uuid1",
      "confessionId": "uuid",
      "type": "spam",
      "currentStatus": "pending",
      "wouldResolve": true
    },
    {
      "reportId": "uuid2",
      "confessionId": "uuid",
      "type": "harassment",
      "currentStatus": "resolved",
      "wouldResolve": false
    }
  ]
}
```

**Error responses:**
- `404` — one or more report IDs were not found
- `403` — caller lacks capability or an active access grant

#### POST /api/admin/reports/bulk-resolve/:previewId/commit
Apply a pending, unexpired preview. Each report must be in exactly the same state as
when the preview was created; any interim change causes a `409`. One audit-log entry
per report is written, tied to the preview run ID.

**Response (200):**
```json
{
  "previewId": "uuid",
  "status": "committed",
  "applied": 1,
  "outcomes": [
    { "reportId": "uuid1", "outcome": "resolved" },
    { "reportId": "uuid2", "outcome": "skipped" }
  ]
}
```

**Error responses:**
- `404` — preview not found (or belongs to a different moderator)
- `409` — preview is no longer pending, or a report changed after preview
- `410` — preview has expired

### Confessions

#### DELETE /api/admin/confessions/:id
Deprecated direct deletion endpoint. It returns `409
ADMIN_ACTION_APPROVAL_REQUIRED` and never deletes the confession. Confession
deletion is currently the only eligible high-impact admin action and requires
approval by a different admin.

#### GET /api/admin/action-approvals
List up to 100 pending high-impact action requests in request order.

#### POST /api/admin/action-approvals
Request a high-impact admin action. Admin authentication is required; this
endpoint does not execute the action.

```json
{
  "action": "confession.delete",
  "targetId": "confession-uuid",
  "reason": "Policy and evidence supporting deletion"
}
```

Requests expire after `ADMIN_ACTION_APPROVAL_TTL_MINUTES` (default `30`,
allowed range `5` to `1440`). The requestor cannot approve their own request.

#### POST /api/admin/action-approvals/:id/approve
Approve and execute a pending request. The approving admin must be different
from the requester and provide recent step-up proof. Approval, soft deletion,
and their audit records commit atomically.

#### POST /api/admin/action-approvals/:id/cancel
Cancel a pending request created by the calling admin. Recent step-up proof is
required. An expired request returns `410 Gone`; terminal requests return
`409 Conflict`.

#### PATCH /api/admin/confessions/:id/hide
Hide a confession from public view.

**Body:**
```json
{
  "reason": "Optional reason for hiding"
}
```

#### PATCH /api/admin/confessions/:id/unhide
Unhide a previously hidden confession.

### Users

#### GET /api/admin/users/search
Search for users by username.

**Query Parameters:**
- `q` (required): Search query
- `limit` (optional, default: 50): Number of results
- `offset` (optional, default: 0): Pagination offset

#### GET /api/admin/users/:id/history
Get user history including reports and confessions.

#### POST /api/admin/users/:id/support-review
Request a least-privilege, audited account snapshot for one of the supported
support purposes. The purpose and scope must match. The endpoint fails closed
if its access-decision audit record cannot be persisted.

```json
{
  "purpose": "account_recovery",
  "scope": "security_status"
}
```

`account_status` returns the account ID, username, role, and active status.
`security_status` returns only the account ID, active status, and whether
two-factor authentication is enabled. Email addresses, message content,
credentials, and other unrelated account fields are never returned.

#### PATCH /api/admin/users/:id/ban
Ban a user.

**Body:**
```json
{
  "reason": "Optional reason for ban"
}
```

#### PATCH /api/admin/users/:id/unban
Unban a user.

### Analytics

#### GET /api/admin/analytics
Get platform analytics and statistics.

**Query Parameters:**
- `startDate` (optional): Start date for analytics period (ISO string)
- `endDate` (optional): End date for analytics period (ISO string)

**Response:**
```json
{
  "overview": {
    "totalUsers": 1000,
    "activeUsers": 500,
    "totalConfessions": 5000,
    "totalReports": 100,
    "bannedUsers": 10,
    "hiddenConfessions": 50,
    "deletedConfessions": 20
  },
  "reports": {
    "byStatus": [...],
    "byType": [...]
  },
  "trends": {
    "confessionsOverTime": [...]
  }
}
```

### Audit Logs

#### GET /api/admin/audit-logs
Get audit logs of all moderation actions.

**Query Parameters:**
- `adminId` (optional): Filter by admin user ID
- `action` (optional): Filter by action type
- `entityType` (optional): Filter by entity type (`report`, `confession`, `user`)
- `entityId` (optional): Filter by specific entity ID
- `limit` (optional, default: 100): Number of results
- `offset` (optional, default: 0): Pagination offset

### Cross-Domain Data Integrity

#### GET /api/admin/integrity/report
Generate a read-only cross-domain integrity verification report across identity, content, export, and moderation domains.

**Query Parameters:**
- `domains` (optional): Comma-separated list of domains to verify (`identity`, `content`, `export`, `moderation`). Defaults to all.
- `limit` (optional, default: 50, max: 200): Maximum violation samples per check.
- `timeoutMs` (optional, default: 5000, max: 30000): Bounded execution time budget in milliseconds.

**Response (200 OK):**
```json
{
  "reportId": "rep-integrity-1718000000000-abc123",
  "generatedAt": "2026-10-18T12:00:00.000Z",
  "executionDurationMs": 42,
  "bounded": {
    "limitPerCheck": 50,
    "timeoutMs": 5000,
    "truncated": false
  },
  "summary": {
    "totalChecks": 11,
    "passedChecks": 11,
    "failedChecks": 0,
    "totalViolations": 0
  },
  "checks": [
    {
      "name": "identity_orphan_user_link",
      "domain": "identity",
      "status": "PASSED",
      "violationsCount": 0,
      "violations": [],
      "durationMs": 4
    }
  ]
}
```

**Stable Error Codes:**
- `ERR_INTEGRITY_IDENTITY_ORPHAN_USER_LINK`: Orphan link to non-existent user.
- `ERR_INTEGRITY_IDENTITY_ORPHAN_ANONYMOUS_LINK`: Orphan link to non-existent anonymous identity.
- `ERR_INTEGRITY_CONTENT_ORPHAN_ANONYMOUS_AUTHOR`: Confession author missing in anonymous user table.
- `ERR_INTEGRITY_CONTENT_ORPHAN_COMMENT_CONFESSION`: Comment referencing non-existent confession.
- `ERR_INTEGRITY_EXPORT_ORPHAN_USER`: Data export request referencing missing user.
- `ERR_INTEGRITY_EXPORT_CHUNK_COUNT_MISMATCH`: Export chunk count mismatch vs stored record.
- `ERR_INTEGRITY_EXPORT_ORPHAN_CHUNK`: Export chunk without valid parent export request.
- `ERR_INTEGRITY_MODERATION_ORPHAN_REPORT_CONFESSION`: Report targeting deleted/missing confession.
- `ERR_INTEGRITY_MODERATION_ORPHAN_REPORTER_USER`: Report with non-existent user reporter ID.
- `ERR_INTEGRITY_MODERATION_ORPHAN_REPORTER_ANONYMOUS`: Report with non-existent anonymous reporter.
- `ERR_INTEGRITY_MODERATION_ORPHAN_EVIDENCE_TARGET`: Moderation evidence without legal hold targeting missing confession.

## Error Responses

All endpoints may return:
- `401 Unauthorized`: Missing or invalid authentication token
- `403 Forbidden`: User is not an admin
- `404 Not Found`: Resource not found
- `400 Bad Request`: Invalid request parameters

## Rate Limiting
Admin endpoints are subject to the same rate limiting as other endpoints (configured via ThrottlerModule).
