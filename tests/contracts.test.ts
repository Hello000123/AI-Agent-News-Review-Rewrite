import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REVIEW_PASS_SCORE,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_STREAM_RESPONSES,
  DEFAULT_TIMEOUT_MS,
  getReviewPassScore,
  getServerConfig,
} from "@/lib/server/config";
import {
  MAX_DRAFT_CHARS,
  calculateWeightedScore,
  editorialInputSchema,
  reviewApiResponseSchema,
  reviewModelResponseSchema,
  reviewResultSchema,
  rewriteRequestSchema,
  sourceSnapshotSchema,
  type SourceSnapshot,
} from "@/lib/shared/contracts";
import { highReview, highReviewModelResponse } from "@/tests/fixtures/reviews";

const source: SourceSnapshot = {
  primaryText: "Original supported facts.",
  userDraft: "Original supported facts.",
  sourceUrl: "https://news.example/article",
  linkedTitle: "Reference article",
  linkedText: "Retrieved reference facts.",
  imageContext: [
    { label: "Chart caption", text: "The chart covers 2026.", source: "user_caption" },
  ],
};

describe("editorial input and review contracts", () => {
  it("requires at least one draft, public source URL, or image-text item", () => {
    expect(editorialInputSchema.safeParse({}).success).toBe(false);
    expect(
      editorialInputSchema.safeParse({
        draft: "   ",
        sourceUrl: "   ",
        imageContext: [],
        outputLanguage: "original",
      }).success,
    ).toBe(false);

    expect(editorialInputSchema.safeParse({ draft: "News soon." }).success).toBe(true);
    expect(
      editorialInputSchema.safeParse({ sourceUrl: "https://news.example/article" }).success,
    ).toBe(true);
    expect(
      editorialInputSchema.safeParse({
        imageContext: [{ label: "OCR", text: "Image fact", source: "ocr_text" }],
      }).success,
    ).toBe(true);
  });

  it("accepts the full editorial input and rejects unsafe URLs or extra fields", () => {
    expect(
      editorialInputSchema.safeParse({
        draft: "Submitted copy.",
        sourceUrl: "https://news.example/article",
        imageContext: [
          { label: "User caption", text: "People outside the venue.", source: "user_caption" },
          { label: "Image OCR", text: "Opening: 16 July", source: "ocr_text" },
        ],
        outputLanguage: "traditional_chinese",
      }).success,
    ).toBe(true);
    expect(editorialInputSchema.safeParse({ sourceUrl: "file:///etc/passwd" }).success).toBe(false);
    expect(editorialInputSchema.safeParse({ draft: "News.", legacy: true }).success).toBe(false);
  });

  it("accepts a draft at the limit and rejects one over the limit", () => {
    expect(editorialInputSchema.safeParse({ draft: "a".repeat(MAX_DRAFT_CHARS) }).success).toBe(
      true,
    );
    expect(
      editorialInputSchema.safeParse({ draft: "a".repeat(MAX_DRAFT_CHARS + 1) }).success,
    ).toBe(false);
  });

  it("validates immutable source snapshots independently from editable input", () => {
    expect(sourceSnapshotSchema.safeParse(source).success).toBe(true);
    expect(sourceSnapshotSchema.safeParse({ ...source, primaryText: "   " }).success).toBe(false);
    expect(sourceSnapshotSchema.safeParse({ ...source, unknown: true }).success).toBe(false);
  });

  it("rejects malformed model scores instead of supplying score defaults", () => {
    const withoutClarity = Object.fromEntries(
      Object.entries(highReviewModelResponse).filter(([key]) => key !== "clarityScore"),
    );
    for (const malformed of [
      withoutClarity,
      { ...highReviewModelResponse, clarityScore: "91" },
      { ...highReviewModelResponse, clarityScore: Number.NaN },
      { ...highReviewModelResponse, clarityScore: 101 },
      { ...highReviewModelResponse, overallScore: -1 },
    ]) {
      expect(reviewModelResponseSchema.safeParse(malformed).success).toBe(false);
    }
  });

  it("rejects invalid derived review fields and unknown properties", () => {
    expect(reviewResultSchema.safeParse({ ...highReview, overallScore: 101 }).success).toBe(false);
    expect(reviewResultSchema.safeParse({ ...highReview, weightedScore: -1 }).success).toBe(false);
    expect(reviewResultSchema.safeParse({ ...highReview, unknown: true }).success).toBe(false);
  });

  it("calculates the documented six-category weighted score", () => {
    expect(
      calculateWeightedScore({
        factualCompletenessScore: 80,
        structureScore: 70,
        clarityScore: 90,
        languageQualityScore: 60,
        professionalismScore: 100,
        attributionScore: 50,
      }),
    ).toBe(77);
  });

  it("requires the review API to return the exact source snapshot it assessed", () => {
    const response = {
      review: highReview,
      source,
      passScore: 80,
      message: "Review complete. Choose how to continue.",
    };

    expect(reviewApiResponseSchema.safeParse(response).success).toBe(true);
    expect(
      reviewApiResponseSchema.safeParse({
        ...response,
        finalText: "A legacy automatic output must not be returned.",
      }).success,
    ).toBe(false);
    expect(
      reviewApiResponseSchema.safeParse({
        review: highReview,
        passScore: 80,
        message: "Missing source snapshot.",
      }).success,
    ).toBe(false);
  });

  it("uses source, calibrated review, and selected language as the rewrite contract", () => {
    expect(
      rewriteRequestSchema.safeParse({
        source,
        review: highReview,
        outputLanguage: "english",
      }).success,
    ).toBe(true);
    expect(
      rewriteRequestSchema.safeParse({
        draft: "Legacy draft-only input.",
        review: highReview,
      }).success,
    ).toBe(false);
    expect(
      rewriteRequestSchema.safeParse({
        source,
        review: { ...highReview, overallScore: 101 },
        outputLanguage: "english",
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
    expect(getServerConfig().model).toBe(DEFAULT_DEEPSEEK_MODEL);
    expect(getServerConfig().streamResponses).toBe(DEFAULT_STREAM_RESPONSES);
  });

  it("accepts configurable threshold, model, URL, and timeout", () => {
    vi.stubEnv("REVIEW_PASS_SCORE", "85");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-pro");
    vi.stubEnv("DEEPSEEK_API_BASE_URL", "https://example.test///");
    vi.stubEnv("DEEPSEEK_TIMEOUT_MS", "120000");
    vi.stubEnv("DEEPSEEK_STREAM", "false");
    vi.stubEnv("DEEPSEEK_API_KEY", " secret ");

    expect(getServerConfig()).toEqual({
      apiKey: "secret",
      apiBaseUrl: "https://example.test",
      model: "deepseek-v4-pro",
      passScore: 85,
      timeoutMs: 120000,
      streamResponses: false,
    });
  });

  it("falls back when the configured API base URL is blank or invalid", () => {
    vi.stubEnv("DEEPSEEK_API_BASE_URL", "   ");
    expect(getServerConfig().apiBaseUrl).toBe("https://api.deepseek.com");

    vi.stubEnv("DEEPSEEK_API_BASE_URL", "file:///tmp/provider");
    expect(getServerConfig().apiBaseUrl).toBe("https://api.deepseek.com");
  });
});
