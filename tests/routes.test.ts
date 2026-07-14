import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as reviewRoute } from "@/app/api/review/route";
import { MAX_DRAFT_CHARS, MAX_REQUEST_BYTES } from "@/lib/shared/contracts";

function request(body: string, contentType = "application/json") {
  return new Request("http://localhost/api/review", {
    method: "POST",
    headers: contentType ? { "Content-Type": contentType } : {},
    body,
  });
}

async function responseErrorCode(response: Response) {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}

describe("review API route validation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns a validation error for empty input", async () => {
    const response = await reviewRoute(request(JSON.stringify({ draft: "   " })));
    expect(response.status).toBe(400);
    expect(await responseErrorCode(response)).toBe("VALIDATION_ERROR");
  });

  it("requires application/json and valid JSON", async () => {
    const wrongType = await reviewRoute(request(JSON.stringify({ draft: "News." }), "text/plain"));
    expect(wrongType.status).toBe(415);
    expect(await responseErrorCode(wrongType)).toBe("UNSUPPORTED_MEDIA_TYPE");

    const malformed = await reviewRoute(request("{"));
    expect(malformed.status).toBe(400);
    expect(await responseErrorCode(malformed)).toBe("INVALID_JSON");
  });

  it("accepts very short input, then reports missing server configuration", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const response = await reviewRoute(request(JSON.stringify({ draft: "News soon." })));
    expect(response.status).toBe(503);
    expect(await responseErrorCode(response)).toBe("DEEPSEEK_NOT_CONFIGURED");
  });

  it("accepts the draft character limit and rejects one character beyond it", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const atLimit = await reviewRoute(
      request(JSON.stringify({ draft: "a".repeat(MAX_DRAFT_CHARS) })),
    );
    expect(atLimit.status).toBe(503);
    expect(await responseErrorCode(atLimit)).toBe("DEEPSEEK_NOT_CONFIGURED");

    const overLimit = await reviewRoute(
      request(JSON.stringify({ draft: "a".repeat(MAX_DRAFT_CHARS + 1) })),
    );
    expect(overLimit.status).toBe(400);
    expect(await responseErrorCode(overLimit)).toBe("VALIDATION_ERROR");
  });

  it("rejects an oversized request before JSON parsing", async () => {
    const response = await reviewRoute(
      request(JSON.stringify({ draft: "a".repeat(MAX_REQUEST_BYTES) })),
    );
    expect(response.status).toBe(413);
    expect(await responseErrorCode(response)).toBe("REQUEST_TOO_LARGE");
  });
});
