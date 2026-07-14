import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as reviewRoute } from "@/app/api/review/route";
import { POST as rewriteRoute } from "@/app/api/rewrite/route";
import { MAX_DRAFT_CHARS, MAX_REQUEST_BYTES } from "@/lib/shared/contracts";
import { highReview, lowReview } from "@/tests/fixtures/reviews";

function request(pathname: string, body: string, contentType = "application/json") {
  return new Request("http://localhost" + pathname, {
    method: "POST",
    headers: contentType ? { "Content-Type": contentType } : {},
    body,
  });
}

function completionResponse(content: string) {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function providerRequestBody(fetchMock: ReturnType<typeof vi.fn>) {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

async function responseErrorCode(response: Response) {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}

describe("review API route validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns a failing review after exactly one Review Agent call without rewriting", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(completionResponse(JSON.stringify(lowReview)));
    vi.stubGlobal("fetch", fetchMock);

    const response = await reviewRoute(
      request("/api/review", JSON.stringify({ draft: "we got update. more soon." })),
    );
    const body = (await response.json()) as Record<string, unknown> & {
      review: { decision: string };
    };

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(providerRequestBody(fetchMock)).toHaveProperty("response_format", {
      type: "json_object",
    });
    expect(body.review.decision).toBe("REWRITE_REQUIRED");
    expect(body).not.toHaveProperty("finalText");
    expect(body).not.toHaveProperty("wasRewritten");
  });

  it("returns a passing review after exactly one Review Agent call without final output", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(completionResponse(JSON.stringify(highReview)));
    vi.stubGlobal("fetch", fetchMock);

    const response = await reviewRoute(
      request("/api/review", JSON.stringify({ draft: "Acme announced a verified update." })),
    );
    const body = (await response.json()) as Record<string, unknown> & {
      review: { decision: string };
    };

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(providerRequestBody(fetchMock)).toHaveProperty("response_format", {
      type: "json_object",
    });
    expect(body.review.decision).toBe("PASS");
    expect(body).not.toHaveProperty("finalText");
    expect(body).not.toHaveProperty("wasRewritten");
  });

  it("runs the Rewrite Agent once through the separate rewrite endpoint", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const finalText = "Concise headline\n\nA clear news report body.";
    const fetchMock = vi.fn().mockResolvedValue(completionResponse(finalText));
    vi.stubGlobal("fetch", fetchMock);

    const response = await rewriteRoute(
      request(
        "/api/rewrite",
        JSON.stringify({ draft: "Original supported facts.", review: highReview }),
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ finalText });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(providerRequestBody(fetchMock)).not.toHaveProperty("response_format");
  });

  it("returns a validation error for empty input", async () => {
    const response = await reviewRoute(request("/api/review", JSON.stringify({ draft: "   " })));
    expect(response.status).toBe(400);
    expect(await responseErrorCode(response)).toBe("VALIDATION_ERROR");
  });

  it("requires application/json and valid JSON", async () => {
    const wrongType = await reviewRoute(
      request("/api/review", JSON.stringify({ draft: "News." }), "text/plain"),
    );
    expect(wrongType.status).toBe(415);
    expect(await responseErrorCode(wrongType)).toBe("UNSUPPORTED_MEDIA_TYPE");

    const malformed = await reviewRoute(request("/api/review", "{"));
    expect(malformed.status).toBe(400);
    expect(await responseErrorCode(malformed)).toBe("INVALID_JSON");
  });

  it("accepts very short input, then reports missing server configuration", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const response = await reviewRoute(
      request("/api/review", JSON.stringify({ draft: "News soon." })),
    );
    expect(response.status).toBe(503);
    expect(await responseErrorCode(response)).toBe("DEEPSEEK_NOT_CONFIGURED");
  });

  it("accepts the draft character limit and rejects one character beyond it", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const atLimit = await reviewRoute(
      request("/api/review", JSON.stringify({ draft: "a".repeat(MAX_DRAFT_CHARS) })),
    );
    expect(atLimit.status).toBe(503);
    expect(await responseErrorCode(atLimit)).toBe("DEEPSEEK_NOT_CONFIGURED");

    const overLimit = await reviewRoute(
      request("/api/review", JSON.stringify({ draft: "a".repeat(MAX_DRAFT_CHARS + 1) })),
    );
    expect(overLimit.status).toBe(400);
    expect(await responseErrorCode(overLimit)).toBe("VALIDATION_ERROR");
  });

  it("rejects an oversized request before JSON parsing", async () => {
    const response = await reviewRoute(
      request("/api/review", JSON.stringify({ draft: "a".repeat(MAX_REQUEST_BYTES) })),
    );
    expect(response.status).toBe(413);
    expect(await responseErrorCode(response)).toBe("REQUEST_TOO_LARGE");
  });
});
