import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiRequestError,
  REWRITE_REQUEST_SAFE_BYTES,
  requestReview,
  requestRewrite,
} from "@/lib/client/api";
import type { RewriteHistoryEntryInput, SourceSnapshot } from "@/lib/shared/contracts";
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
        }),
    ],
    ["rewrite", () => requestRewrite(source, highReview)],
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

  it("posts typed rewrite history and the latest refinement", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          finalText: "Latest headline\n\nLatest rewritten report.",
          validation: { status: "passed", attempts: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await requestRewrite(
      source,
      highReview,
      [
        {
          rewrittenText: "Earlier headline\n\nEarlier rewritten report.",
          lengthOption: "concise",
          instruction: "Make the opening stronger.",
        },
        {
          rewrittenText: "Current headline\n\nCurrent rewritten report.",
          lengthOption: null,
          instruction: "Use a more formal tone.",
        },
      ],
      {
        lengthOption: "more_detailed",
        instruction: "Focus on the programme benefits.",
      },
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      source,
      review: highReview,
      history: [
        {
          rewrittenText: "Earlier headline\n\nEarlier rewritten report.",
          lengthOption: "concise",
          instruction: "Make the opening stronger.",
        },
        {
          rewrittenText: "Current headline\n\nCurrent rewritten report.",
          lengthOption: null,
          instruction: "Use a more formal tone.",
        },
      ],
      refinement: {
        lengthOption: "more_detailed",
        instruction: "Focus on the programme benefits.",
      },
    });
  });

  it("compacts only older rewritten text while preserving instructions and the current version", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          finalText: "Latest headline\n\nLatest rewritten report.",
          validation: { status: "passed", attempts: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const history: RewriteHistoryEntryInput[] = Array.from({ length: 5 }, (_value, index) => ({
      rewrittenText: `${index}-${"\u7a3f".repeat(45_000)}`,
      lengthOption: index % 2 === 0 ? "concise" : "more_detailed",
      instruction: `Instruction ${index}`,
    }));
    const originalHistory = structuredClone(history);

    await requestRewrite(source, highReview, history, {
      lengthOption: null,
      instruction: "Latest instruction",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const serialized = String(init.body);
    const posted = JSON.parse(serialized) as {
      history: Array<{
        rewrittenText?: string;
        lengthOption: "concise" | "more_detailed" | null;
        instruction: string;
      }>;
      refinement: { lengthOption: null; instruction: string };
    };
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
      REWRITE_REQUEST_SAFE_BYTES,
    );
    expect(posted.history.some((entry) => entry.rewrittenText === undefined)).toBe(true);
    expect(posted.history.map(({ instruction }) => instruction)).toEqual(
      history.map(({ instruction }) => instruction),
    );
    expect(posted.history.map(({ lengthOption }) => lengthOption)).toEqual(
      history.map(({ lengthOption }) => lengthOption),
    );
    expect(posted.history.at(-1)?.rewrittenText).toBe(history.at(-1)?.rewrittenText);
    expect(posted.refinement).toEqual({
      lengthOption: null,
      instruction: "Latest instruction",
    });
    expect(history).toEqual(originalHistory);
  });
});
