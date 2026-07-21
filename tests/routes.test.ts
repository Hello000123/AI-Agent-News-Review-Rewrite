import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as reviewRoute } from "@/app/api/review/route";
import { POST as rewriteRoute } from "@/app/api/rewrite/route";
import {
  MAX_DRAFT_CHARS,
  MAX_REQUEST_BYTES,
  type ReviewResult,
  type SourceSnapshot,
} from "@/lib/shared/contracts";
import {
  highReview,
  highReviewModelResponse,
  lowReviewModelResponse,
} from "@/tests/fixtures/reviews";

const PUBLIC_SOURCE_URL = "https://93.184.216.34/reference-article";

const rewriteSource: SourceSnapshot = {
  primaryText: "Officials confirmed the supported update.",
  userDraft: "Officials confirmed the supported update.",
  sourceUrl: "https://news.example/reference",
  linkedTitle: "Supporting reference",
  linkedText: "The source supports the confirmed update.",
  imageContext: [
    { label: "Page caption", text: "Officials at the briefing.", source: "link_caption" },
  ],
};

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
      choices: [
        {
          finish_reason: "stop",
          message: { content, reasoning_content: "PRIVATE_REASONING_MARKER" },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function providerCall(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0) {
  const call = fetchMock.mock.calls.filter(([url]) =>
    String(url).includes("/chat/completions"),
  )[callIndex];
  if (!call) throw new Error("Expected a DeepSeek provider call.");
  return call as unknown as [string, RequestInit];
}

function providerRequestBody(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0) {
  const [, init] = providerCall(fetchMock, callIndex);
  return JSON.parse(String(init.body)) as {
    response_format?: unknown;
    messages: Array<{ role: string; content: string }>;
  };
}

function providerUserPrompt(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0) {
  const body = providerRequestBody(fetchMock, callIndex);
  return body.messages.find(({ role }) => role === "user")?.content ?? "";
}

async function responseErrorCode(response: Response) {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}

describe("review and rewrite API routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns a calibrated failing review after exactly one Review Agent call", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(completionResponse(JSON.stringify(lowReviewModelResponse)));
    vi.stubGlobal("fetch", fetchMock);

    const response = await reviewRoute(
      request("/api/review", JSON.stringify({ draft: "we got update. more soon." })),
    );
    const body = (await response.json()) as Record<string, unknown> & {
      review: ReviewResult;
      source: SourceSnapshot;
    };

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(providerRequestBody(fetchMock)).toHaveProperty("response_format", {
      type: "json_object",
    });
    expect(body.review).toMatchObject({
      overallScore: 41,
      weightedScore: 41,
      appliedScoreCap: 59,
      readinessBand: "WEAK",
      decision: "REWRITE_REQUIRED",
    });
    expect(body.source).toEqual({
      primaryText: "we got update. more soon.",
      userDraft: "we got update. more soon.",
      imageContext: [],
    });
    expect(body).not.toHaveProperty("finalText");
    expect(body).not.toHaveProperty("wasRewritten");
  });

  it("accepts full editorial input and returns the retrieved source snapshot it reviewed", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const sourceHtml = `
      <html><head><meta property="og:title" content="Reference headline"></head><body>
        <article itemprop="articleBody">
          <h1>Reference headline</h1>
          <p>The retrieved reference confirms the pilot was completed after an independent review and supplies supporting context for the submitted copy.</p>
          <figure><img alt="Officials presenting the pilot"><figcaption>Officials at the briefing.</figcaption></figure>
        </article>
      </body></html>`;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === PUBLIC_SOURCE_URL) {
        return new Response(sourceHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return completionResponse(JSON.stringify(highReviewModelResponse));
    });
    vi.stubGlobal("fetch", fetchMock);

    const editorialInput = {
      draft: "The submitted draft says the pilot is complete.",
      sourceUrl: PUBLIC_SOURCE_URL,
    } as const;
    const response = await reviewRoute(
      request("/api/review", JSON.stringify(editorialInput)),
    );
    const body = (await response.json()) as {
      review: ReviewResult;
      source: SourceSnapshot;
      passScore: number;
    };

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body.review).toMatchObject({ overallScore: 91, decision: "PASS" });
    expect(body.source).toMatchObject({
      primaryText: editorialInput.draft,
      userDraft: editorialInput.draft,
      sourceUrl: PUBLIC_SOURCE_URL,
      linkedTitle: "Reference headline",
      linkedText: expect.stringContaining("retrieved reference confirms the pilot"),
    });
    expect(body.source.imageContext).toEqual(
      [
        expect.objectContaining({
          source: "link_caption",
          text: expect.stringContaining("Officials presenting the pilot"),
        }),
      ],
    );

    const providerBody = providerRequestBody(fetchMock);
    expect(providerBody).toHaveProperty("response_format", { type: "json_object" });
    const userPrompt = providerUserPrompt(fetchMock);
    expect(userPrompt).toContain(editorialInput.draft);
    expect(userPrompt).toContain(PUBLIC_SOURCE_URL);
    expect(userPrompt).toContain("Reference headline");
    expect(userPrompt).toContain("retrieved reference confirms the pilot");
    expect(userPrompt).toContain("Officials at the briefing.");
  });

  it("derives the source language and rewrites even when the review score is high", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const finalText =
      "Supported update confirmed\n\nOfficials confirmed the supported update in a clearer report.";
    const fetchMock = vi.fn().mockResolvedValue(completionResponse(finalText));
    vi.stubGlobal("fetch", fetchMock);

    const response = await rewriteRoute(
      request(
        "/api/rewrite",
        JSON.stringify({
          source: rewriteSource,
          review: highReview,
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      finalText,
      validation: { status: "passed", attempts: 1 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(providerRequestBody(fetchMock)).not.toHaveProperty("response_format");
    const userPrompt = providerUserPrompt(fetchMock);
    expect(userPrompt).toContain("LANGUAGE LOCK: English");
    expect(userPrompt).toContain('"primaryText": "Officials confirmed the supported update."');
    expect(userPrompt).toContain('"requiredOutputLanguage": "English"');
    expect(userPrompt).toContain('"sourceUrl": "https://news.example/reference"');
  });

  it.each([
    {
      language: "English",
      expectedLanguageLock: "English",
      draft:
        "The city library opened a new reading room on Thursday. The library said the space will host free community workshops.",
      rewritten:
        "City library opens community reading room\n\nThe city library opened a new reading room on Thursday and said the space will host free community workshops.",
    },
    {
      language: "Traditional Chinese",
      expectedLanguageLock: "Chinese",
      draft: "市立圖書館周四啟用新的閱讀室。館方表示，該空間將舉辦免費社區工作坊。",
      rewritten:
        "市立圖書館啟用社區閱讀室\n\n市立圖書館周四啟用新的閱讀室，館方表示該空間將舉辦免費社區工作坊。",
    },
  ])("completes the $language Review and Rewrite chain", async ({
    expectedLanguageLock,
    draft,
    rewritten,
  }) => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(completionResponse(JSON.stringify(highReviewModelResponse)))
      .mockResolvedValueOnce(completionResponse(rewritten));
    vi.stubGlobal("fetch", fetchMock);

    const reviewResponse = await reviewRoute(
      request("/api/review", JSON.stringify({ draft })),
    );
    expect(reviewResponse.status).toBe(200);
    const reviewed = (await reviewResponse.json()) as {
      review: ReviewResult;
      source: SourceSnapshot;
    };

    const rewriteResponse = await rewriteRoute(
      request(
        "/api/rewrite",
        JSON.stringify({
          source: reviewed.source,
          review: reviewed.review,
        }),
      ),
    );
    expect(rewriteResponse.status).toBe(200);
    const rewrittenBody = (await rewriteResponse.json()) as { finalText: string };
    expect(rewrittenBody.finalText).toBe(rewritten);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(providerUserPrompt(fetchMock, 1)).toContain(`LANGUAGE LOCK: ${expectedLanguageLock}`);
    expect(JSON.stringify(reviewed)).not.toContain("PRIVATE_REASONING_MARKER");
    expect(JSON.stringify(rewrittenBody)).not.toContain("PRIVATE_REASONING_MARKER");
  });

  it("returns complete safe diagnostics for a deliberately invalid model", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.stubEnv("DEEPSEEK_MODEL", "invalid-model-diagnostic");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message:
              "The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed invalid-model-diagnostic.",
            type: "invalid_request_error",
            code: "invalid_request_error",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await reviewRoute(
      request("/api/review", JSON.stringify({ draft: "Test invalid model handling." })),
    );
    const body = (await response.json()) as {
      error: Record<string, unknown>;
    };

    expect(response.status).toBe(502);
    expect(body.error).toMatchObject({
      code: "DEEPSEEK_MODEL_ERROR",
      stage: "review_request",
      provider: "DeepSeek",
      model: "invalid-model-diagnostic",
      httpStatus: 400,
      retryable: false,
      causeSummary: expect.stringContaining("Supported model IDs"),
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("test-key");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("PRIVATE_REASONING_MARKER");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed when model scores are missing, non-numeric, or out of range", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    for (const malformedReview of [
      { ...highReviewModelResponse, clarityScore: "91" },
      { ...highReviewModelResponse, clarityScore: 101 },
      Object.fromEntries(
        Object.entries(highReviewModelResponse).filter(([key]) => key !== "clarityScore"),
      ),
    ]) {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(completionResponse(JSON.stringify(malformedReview)));
      vi.stubGlobal("fetch", fetchMock);
      const response = await reviewRoute(
        request("/api/review", JSON.stringify({ draft: "Complete submitted copy." })),
      );
      expect(response.status).toBe(502);
      expect(await responseErrorCode(response)).toBe("INVALID_REVIEW_FORMAT");
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it("returns a validation error for empty editorial input", async () => {
    const response = await reviewRoute(
      request(
        "/api/review",
        JSON.stringify({
          draft: "   ",
          sourceUrl: "",
        }),
      ),
    );
    expect(response.status).toBe(400);
    expect(await responseErrorCode(response)).toBe("VALIDATION_ERROR");
  });

  it("rejects the removed output-language request field", async () => {
    const reviewResponse = await reviewRoute(
      request(
        "/api/review",
        JSON.stringify({ draft: "Complete submitted copy.", outputLanguage: "english" }),
      ),
    );
    expect(reviewResponse.status).toBe(400);
    expect(await responseErrorCode(reviewResponse)).toBe("VALIDATION_ERROR");

    const rewriteResponse = await rewriteRoute(
      request(
        "/api/rewrite",
        JSON.stringify({ source: rewriteSource, review: highReview, outputLanguage: "english" }),
      ),
    );
    expect(rewriteResponse.status).toBe(400);
    expect(await responseErrorCode(rewriteResponse)).toBe("VALIDATION_ERROR");
  });

  it("rejects the removed picture-input field", async () => {
    const response = await reviewRoute(
      request(
        "/api/review",
        JSON.stringify({
          draft: "Complete submitted copy.",
          imageContext: [
            {
              label: "Legacy page caption",
              text: "Legacy image text",
              source: "link_caption",
            },
          ],
        }),
      ),
    );
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
