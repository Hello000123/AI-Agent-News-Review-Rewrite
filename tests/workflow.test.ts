import { describe, expect, it, vi } from "vitest";

import { parseReviewResponse } from "@/lib/server/agents/review-agent";
import {
  reviewAndMaybeRewrite,
  rewriteWithFeedback,
} from "@/lib/server/agents/workflow";
import { highReview, lowReview } from "@/tests/fixtures/reviews";

describe("review and rewrite workflow", () => {
  it("automatically rewrites a low-scoring draft", async () => {
    const completion = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(lowReview))
      .mockResolvedValueOnce("FOR IMMEDIATE RELEASE\n\n[Company Name] today announced an update.");

    const result = await reviewAndMaybeRewrite("we got update. more soon.", {
      passScore: 80,
      completionRunner: completion,
    });

    expect(result.review.decision).toBe("REWRITE_REQUIRED");
    expect(result.wasRewritten).toBe(true);
    expect(result.finalText).toContain("[Company Name]");
    expect(completion).toHaveBeenCalledTimes(2);
    expect(completion.mock.calls[0][0].responseFormat).toBe("json");
    expect(completion.mock.calls[0][0].temperature).toBe(0);
    expect(completion.mock.calls[1][0].responseFormat).toBe("text");
  });

  it("returns the untouched original when a high-scoring draft passes", async () => {
    const draft = "FOR IMMEDIATE RELEASE\n\nAcme today announced a verified product update.";
    const completion = vi.fn().mockResolvedValue(JSON.stringify(highReview));

    const result = await reviewAndMaybeRewrite(draft, {
      passScore: 80,
      completionRunner: completion,
    });

    expect(result.review.decision).toBe("PASS");
    expect(result.wasRewritten).toBe(false);
    expect(result.finalText).toBe(draft);
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it("supports a manual rewrite after a passing review", async () => {
    const completion = vi.fn().mockResolvedValue("A fresh professional version.");
    const result = await rewriteWithFeedback("Original draft.", highReview, completion);

    expect(result).toBe("A fresh professional version.");
    expect(completion.mock.calls[0][0].responseFormat).toBe("text");
  });

  it("supports repeated rewrite requests without changing the original facts payload", async () => {
    const completion = vi
      .fn()
      .mockResolvedValueOnce("First rewrite.")
      .mockResolvedValueOnce("Second rewrite.");

    expect(await rewriteWithFeedback("Original facts.", lowReview, completion)).toBe("First rewrite.");
    expect(await rewriteWithFeedback("Original facts.", lowReview, completion)).toBe("Second rewrite.");
    expect(completion.mock.calls[0][0].userPrompt).toContain("Original facts.");
    expect(completion.mock.calls[1][0].userPrompt).toContain("Original facts.");
  });

  it("normalizes model arithmetic and decision against weighted categories", () => {
    const parsedHigh = parseReviewResponse(
      JSON.stringify({ ...highReview, overallScore: 12, decision: "REWRITE_REQUIRED" }),
      80,
    );
    const parsedLow = parseReviewResponse(
      JSON.stringify({ ...lowReview, overallScore: 99, decision: "PASS" }),
      80,
    );

    expect(parsedHigh.overallScore).toBe(91);
    expect(parsedHigh.decision).toBe("PASS");
    expect(parsedLow.overallScore).toBe(45);
    expect(parsedLow.decision).toBe("REWRITE_REQUIRED");
  });

  it("fails safely on malformed JSON or an incomplete review object", () => {
    expect(() => parseReviewResponse("not json", 80)).toThrowError(
      expect.objectContaining({ code: "MALFORMED_REVIEW_JSON" }),
    );
    expect(() => parseReviewResponse(JSON.stringify({ overallScore: 50 }), 80)).toThrowError(
      expect.objectContaining({ code: "INVALID_REVIEW_FORMAT" }),
    );
  });

  it("removes a lone markdown fence from an otherwise valid rewrite", async () => {
    const fenced = "\x60\x60\x60text\nFOR IMMEDIATE RELEASE\n\x60\x60\x60";
    const completion = vi.fn().mockResolvedValue(fenced);
    await expect(rewriteWithFeedback("Original.", lowReview, completion)).resolves.toBe(
      "FOR IMMEDIATE RELEASE",
    );
  });
});
