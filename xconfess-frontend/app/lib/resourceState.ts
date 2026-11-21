export type ResourceState =
  | "missing"
  | "deleted"
  | "private"
  | "expired"
  | "unavailable";

export function getResourceState(status: number | undefined): ResourceState {
  if (status === 404) return "missing";
  if (status === 410) return "deleted";
  if (status === 403 || status === 401) return "private";
  if (status === 419) return "expired";
  return "unavailable";
}

export function isSafeResourceStatus(status: number | undefined): boolean {
  return (
    status === 404 ||
    status === 410 ||
    status === 403 ||
    status === 401 ||
    status === 419
  );
}

export const SAFE_RESOURCE_STATE_COPY = {
  title: "Resource unavailable",
  description:
    "This resource is unavailable. The link may be invalid or it may no longer be accessible.",
};

export const RESOURCE_STATE_COPY: Record<
  Exclude<ResourceState, "unavailable">,
  { title: string; description: string }
> = {
  missing: SAFE_RESOURCE_STATE_COPY,
  deleted: SAFE_RESOURCE_STATE_COPY,
  private: SAFE_RESOURCE_STATE_COPY,
  expired: SAFE_RESOURCE_STATE_COPY,
};
