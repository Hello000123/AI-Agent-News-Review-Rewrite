import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError, requestReview, requestRewrite } from "@/lib/client/api";
import type { SourceSnapshot } from "@/lib/shared/contracts";
import { highReview } from "@/tests/fixtures/reviews";

const source: SourceSnapshot = {
  primaryText: "Original supported facts.",
  userDraft: "Original supported facts.",
  imageContext: [],
};

describe("client API response validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [
      "review",
      () =>
        requestReview({
          draft: source.primaryText,
          sourceUrl: "",
          imageContext: [],
          outputLanguage: "original",
        }),
    ],
    ["rewrite", () => requestRewrite(source, highReview, "english")],
  ])("rejects a malformed successful %s response", async (_label, request) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: "private-payload-marker" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    let failure: ApiRequestError | undefined;
    try {
      await request();
    } catch (error) {
      failure = error as ApiRequestError;
    }

    expect(failure).toBeInstanceOf(ApiRequestError);
    expect(failure).toMatchObject({
      name: "ApiRequestError",
      code: "INVALID_SERVER_RESPONSE",
    });
    expect(failure?.message).not.toContain("private-payload-marker");
  });

  it("uses a safe generic error when the server error body is malformed", async () => {
    const sensitiveProviderDetail = "provider stack and private diagnostic detail";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 500,
              message: { sensitiveProviderDetail },
            },
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    let failure: ApiRequestError | undefined;
    try {
      await requestReview({
        draft: source.primaryText,
        sourceUrl: "",
        imageContext: [],
        outputLanguage: "original",
      });
    } catch (error) {
      failure = error as ApiRequestError;
    }

    expect(failure).toMatchObject({
      name: "ApiRequestError",
      code: "REQUEST_FAILED",
      message: "The request failed. Please try again.",
    });
    expect(failure?.message).not.toContain(sensitiveProviderDetail);
    expect(failure?.details).toBeUndefined();
  });

  it("preserves allowlisted provider diagnostics for a rejected model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "DEEPSEEK_MODEL_ERROR",
              message: "DeepSeek rejected the configured model.",
              retryable: false,
              stage: "review_request",
              provider: "DeepSeek",
              model: "invalid-model-diagnostic",
              httpStatus: 400,
              causeSummary:
                "DeepSeek rejected configured model invalid-model-diagnostic. Supported model IDs are deepseek-v4-pro and deepseek-v4-flash.",
            },
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    let failure: ApiRequestError | undefined;
    try {
      await requestReview({
        draft: source.primaryText,
        sourceUrl: "",
        imageContext: [],
        outputLanguage: "original",
      });
    } catch (error) {
      failure = error as ApiRequestError;
    }

    expect(failure).toMatchObject({
      code: "DEEPSEEK_MODEL_ERROR",
      details: {
        retryable: false,
        stage: "review_request",
        provider: "DeepSeek",
        model: "invalid-model-diagnostic",
        httpStatus: 400,
        causeSummary: expect.stringContaining("Supported model IDs"),
      },
    });
    expect(JSON.stringify(failure)).not.toContain("Authorization");
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_REASONING_MARKER");
  });
});
