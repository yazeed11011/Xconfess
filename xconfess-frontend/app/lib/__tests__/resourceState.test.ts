import {
  getResourceState,
  isSafeResourceStatus,
  RESOURCE_STATE_COPY,
  SAFE_RESOURCE_STATE_COPY,
} from "@/app/lib/resourceState";

describe("resource state classification", () => {
  it.each([
    [404, "missing"],
    [410, "deleted"],
    [401, "private"],
    [403, "private"],
    [419, "expired"],
  ] as const)("maps status %i to %s", (status, state) => {
    expect(getResourceState(status)).toBe(state);
  });

  it("uses neutral copy for private resources", () => {
    expect(RESOURCE_STATE_COPY.private.title).toBe("Resource unavailable");
    expect(RESOURCE_STATE_COPY.private.description).not.toContain("owner");
  });

  it("uses the same safe presentation for unavailable resource states", () => {
    for (const state of ["missing", "deleted", "private", "expired"] as const) {
      expect(RESOURCE_STATE_COPY[state]).toBe(SAFE_RESOURCE_STATE_COPY);
    }
  });

  it("recognizes privacy-sensitive statuses without classifying server failures", () => {
    expect([404, 410, 401, 403, 419].every(isSafeResourceStatus)).toBe(true);
    expect(isSafeResourceStatus(500)).toBe(false);
  });
});
