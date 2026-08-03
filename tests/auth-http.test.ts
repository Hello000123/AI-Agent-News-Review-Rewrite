import { afterEach, describe, expect, it, vi } from "vitest";

import { authErrorResponse } from "@/lib/server/auth/http";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authentication error handling", () => {
  it("returns a support reference and logs safe metadata without exposing the exception", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = authErrorResponse(
      new Error("sensitive database details and SQL"),
      {
        operation: "auth.login",
        request: new Request("https://app.example/api/auth/login", {
          method: "POST",
        }),
      },
    );
    const body = (await response.json()) as {
      error: { message: string; requestId: string };
    };

    expect(response.status).toBe(500);
    expect(body.error.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(body.error.message).toContain(body.error.requestId);
    expect(body.error.message).not.toContain("database");
    expect(log).toHaveBeenCalledWith(
      "[auth] Request failed",
      expect.objectContaining({
        requestId: body.error.requestId,
        operation: "auth.login",
        method: "POST",
        pathname: "/api/auth/login",
        errorType: "Error",
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive database details");
  });
});
