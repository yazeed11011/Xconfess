/**
 * @jest-environment jsdom
 */
import { GET } from "../route";

jest.mock("@/app/lib/api/proxy", () => ({
  resolveBackendRoute: () => ({ url: "http://backend.test/confessions/test-id" }),
}));

jest.mock("@/app/lib/utils/requestId", () => ({
  getOrCreateRequestId: () => "test-request-id",
}));

describe("GET /api/confessions/[id]", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([401, 403, 404, 410, 419])(
    "returns a generic no-store response for status %i",
    async (status) => {
      jest.spyOn(global, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ message: "INTERNAL RESOURCE DETAIL" }), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const response = await GET(
        new Request("http://frontend.test/api/confessions/test-id"),
        { params: Promise.resolve({ id: "test-id" }) },
      );
      const body = await response.json();

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body.message).toBe("This resource is unavailable.");
      expect(JSON.stringify(body)).not.toContain("INTERNAL RESOURCE DETAIL");
    },
  );

  it("does not expose upstream server details", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "database password and stack trace" }), {
        status: 500,
      }),
    );

    const response = await GET(
      new Request("http://frontend.test/api/confessions/test-id"),
      { params: Promise.resolve({ id: "test-id" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("database password");
    expect(body.message).toBe("The server could not complete the request. Please try again.");
  });

  it("uses a retryable failure response when the backend is unreachable", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED internal host"));

    const response = await GET(
      new Request("http://frontend.test/api/confessions/test-id"),
      { params: Promise.resolve({ id: "test-id" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });
});
