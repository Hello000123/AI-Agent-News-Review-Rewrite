import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REVIEW_PASS_SCORE,
  DEFAULT_TIMEOUT_MS,
  getReviewPassScore,
  getServerConfig,
} from "@/lib/server/config";
import {
  MAX_DRAFT_CHARS,
  calculateOverallScore,
  draftSchema,
  reviewApiResponseSchema,
  reviewResultSchema,
  rewriteRequestSchema,
} from "@/lib/shared/contracts";
import { highReview } from "@/tests/fixtures/reviews";

describe("input and review contracts", () => {
  it("rejects an empty or whitespace-only draft", () => {
    expect(draftSchema.safeParse("").success).toBe(false);
    expect(draftSchema.safeParse("   \n\t").success).toBe(false);
  });

  it("accepts a very short draft for the Review Agent to assess", () => {
    expect(draftSchema.safeParse("News soon.").success).toBe(true);
  });

  it("accepts a draft at the limit and rejects one over the limit", () => {
    expect(draftSchema.safeParse("a".repeat(MAX_DRAFT_CHARS)).success).toBe(true);
    expect(draftSchema.safeParse("a".repeat(MAX_DRAFT_CHARS + 1)).success).toBe(false);
  });

  it("rejects out-of-range scores, missing fields, and extra fields", () => {
    expect(reviewResultSchema.safeParse({ ...highReview, overallScore: 101 }).success).toBe(false);
    const missingField = Object.fromEntries(
      Object.entries(highReview).filter(([key]) => key !== "clarityScore"),
    );
    expect(reviewResultSchema.safeParse(missingField).success).toBe(false);
    expect(reviewResultSchema.safeParse({ ...highReview, unknown: true }).success).toBe(false);
  });

  it("calculates the documented weighted overall score", () => {
    expect(
      calculateOverallScore({
        contentScore: 80,
        clarityScore: 90,
        structureScore: 70,
        toneScore: 100,
        writingScore: 60,
      }),
    ).toBe(82);
  });

  it("accepts a review-only API response and rejects legacy automatic-output fields", () => {
    const response = {
      review: highReview,
      passScore: 80,
      message: "Review complete. Choose how to continue.",
    };

    expect(reviewApiResponseSchema.safeParse(response).success).toBe(true);
    expect(
      reviewApiResponseSchema.safeParse({
        ...response,
        finalText: "An automatic output must not be returned.",
        wasRewritten: false,
      }).success,
    ).toBe(false);
  });

  it("keeps rewrite input as a separate validated draft-and-review contract", () => {
    expect(
      rewriteRequestSchema.safeParse({ draft: "Original supported facts.", review: highReview })
        .success,
    ).toBe(true);
    expect(
      rewriteRequestSchema.safeParse({
        draft: "Original supported facts.",
        review: { ...highReview, overallScore: 101 },
      }).success,
    ).toBe(false);
  });
});

describe("server configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses safe defaults for absent or invalid numeric settings", () => {
    vi.stubEnv("REVIEW_PASS_SCORE", "not-a-number");
    vi.stubEnv("DEEPSEEK_TIMEOUT_MS", "50");
    expect(getReviewPassScore()).toBe(DEFAULT_REVIEW_PASS_SCORE);
    expect(getServerConfig().timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("accepts configurable threshold, model, URL, and timeout", () => {
    vi.stubEnv("REVIEW_PASS_SCORE", "85");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-pro");
    vi.stubEnv("DEEPSEEK_API_BASE_URL", "https://example.test///");
    vi.stubEnv("DEEPSEEK_TIMEOUT_MS", "120000");
    vi.stubEnv("DEEPSEEK_API_KEY", " secret ");

    expect(getServerConfig()).toEqual({
      apiKey: "secret",
      apiBaseUrl: "https://example.test",
      model: "deepseek-v4-pro",
      passScore: 85,
      timeoutMs: 120000,
    });
  });

  it("falls back when the configured API base URL is blank or invalid", () => {
    vi.stubEnv("DEEPSEEK_API_BASE_URL", "   ");
    expect(getServerConfig().apiBaseUrl).toBe("https://api.deepseek.com");

    vi.stubEnv("DEEPSEEK_API_BASE_URL", "file:///tmp/provider");
    expect(getServerConfig().apiBaseUrl).toBe("https://api.deepseek.com");
  });
});
