# Frontend resource and cache policy

## Resource states

Frontend resource detail views classify deleted (410), expired (419), private
(401/403), missing (404), and unavailable (network/server) responses. Privacy-
sensitive states deliberately render the same neutral title and description,
without the resource identifier, owner, or existence. This means clients cannot
infer whether a missing, deleted, expired, private, or unauthorized resource
exists.

The confession proxy never substitutes demo content for an upstream 404 or
network failure. It returns the original privacy-sensitive status with a generic
body and `Cache-Control: no-store`; upstream 5xx details are not copied into
response bodies or displayed by the UI. Server failures remain separate and
provide an explicit retry action.

## Account isolation

Authentication transitions clear the in-memory React Query cache. Account
changes also remove account-specific search, draft, pending-confession, settings,
scroll, and auth state from client storage. Query data is never reused until the
new account is explicitly resolved.

## Cache policy manifest

`xconfess-frontend/cache-policy-manifest.json` declares public and private route
classes. Private API and admin routes must not be returned with shared-cache
directives. Public routes may be cached only when they contain no authentication
credentials or account-specific content.

CI runs `npm run validate:cache-policy --workspace=xconfess-frontend` to reject
invalid classifications and accidental public labels for account or admin routes.
