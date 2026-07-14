import { describe, expect, it, vi } from "vitest";

import { parseReviewResponse } from "@/lib/server/agents/review-agent";
import { reviewDraft, rewriteWithFeedback } from "@/lib/server/agents/workflow";
import { highReview, lowReview } from "@/tests/fixtures/reviews";

describe("review and rewrite workflow", () => {
  it("returns a failing review after exactly one Review Agent call without rewriting", async () => {
    const completion = vi.fn().mockResolvedValue(JSON.stringify(lowReview));

    const result = await reviewDraft("we got update. more soon.", {
      passScore: 80,
      completionRunner: completion,
    });

    expect(result.review.decision).toBe("REWRITE_REQUIRED");
    expect(result).not.toHaveProperty("wasRewritten");
    expect(result).not.toHaveProperty("finalText");
    expect(result.message).toContain("below the quality threshold");
    expect(completion).toHaveBeenCalledTimes(1);
    expect(completion.mock.calls[0][0].responseFormat).toBe("json");
    expect(completion.mock.calls[0][0].temperature).toBe(0);
  });

  it("returns a passing review after exactly one Review Agent call without final output", async () => {
    const draft = "Acme announced a verified product update.";
    const completion = vi.fn().mockResolvedValue(JSON.stringify(highReview));

    const result = await reviewDraft(draft, {
      passScore: 80,
      completionRunner: completion,
    });

    expect(result.review.decision).toBe("PASS");
    expect(result).not.toHaveProperty("wasRewritten");
    expect(result).not.toHaveProperty("finalText");
    expect(result.message).toContain("meets the quality threshold");
    expect(completion).toHaveBeenCalledTimes(1);
    expect(completion.mock.calls[0][0].responseFormat).toBe("json");
  });

  it("makes one separate Rewrite Agent call only when explicitly requested", async () => {
    const completion = vi.fn().mockResolvedValue("Fresh headline\n\nA fresh professional version.");
    const result = await rewriteWithFeedback("Original draft.", highReview, completion);

    expect(result).toBe("Fresh headline\n\nA fresh professional version.");
    expect(completion).toHaveBeenCalledTimes(1);
    expect(completion.mock.calls[0][0].responseFormat).toBe("text");
    expect(completion.mock.calls[0][0].temperature).toBe(0.1);
  });

  it("supports repeated rewrite requests without changing the original facts payload", async () => {
    const completion = vi
      .fn()
      .mockResolvedValueOnce("First headline\n\nFirst rewrite.")
      .mockResolvedValueOnce("Second headline\n\nSecond rewrite.");

    expect(await rewriteWithFeedback("Original facts.", lowReview, completion)).toBe(
      "First headline\n\nFirst rewrite.",
    );
    expect(await rewriteWithFeedback("Original facts.", lowReview, completion)).toBe(
      "Second headline\n\nSecond rewrite.",
    );
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
    const fenced = "\x60\x60\x60text\nConcise headline\n\nArticle body.\n\x60\x60\x60";
    const completion = vi.fn().mockResolvedValue(fenced);
    await expect(rewriteWithFeedback("Original.", lowReview, completion)).resolves.toBe(
      "Concise headline\n\nArticle body.",
    );
  });

  it("rejects a rewrite that drops a direct quotation or violates the output format", async () => {
    const droppedQuote = vi.fn().mockResolvedValue("Headline\n\nThe source described progress.");
    await expect(
      rewriteWithFeedback('A source said, “Keep this exact.”', lowReview, droppedQuote),
    ).rejects.toMatchObject({ code: "INEXACT_REWRITE_QUOTATION" });

    const invalidFormat = vi.fn().mockResolvedValue("Headline without a separated body");
    await expect(
      rewriteWithFeedback("Original facts.", lowReview, invalidFormat),
    ).rejects.toMatchObject({ code: "INVALID_REWRITE_FORMAT" });
  });

  it("requires every occurrence of repeated and multiline direct quotations", async () => {
    const droppedOccurrence = vi
      .fn()
      .mockResolvedValue("Sources repeat warning\n\nThe first source said, “Keep\nthis exact.”");
    await expect(
      rewriteWithFeedback(
        "The first source said, “Keep\nthis exact.” The second source also said, “Keep\nthis exact.”",
        lowReview,
        droppedOccurrence,
      ),
    ).rejects.toMatchObject({ code: "INEXACT_REWRITE_QUOTATION" });
  });

  it("rejects a rewrite that translates or changes a mixed-language source term", async () => {
    const translatedTerm = vi
      .fn()
      .mockResolvedValue("測試完成\n\n項目已在數碼港完成測試。");
    await expect(
      rewriteWithFeedback("項目已在Cyberport完成測試。", lowReview, translatedTerm),
    ).rejects.toMatchObject({ code: "INEXACT_MIXED_LANGUAGE_TERM" });
  });

  it("rejects a rewrite that switches a Traditional Chinese draft to English", async () => {
    const englishOutput = vi.fn().mockResolvedValue(
      "Blue Harbour AI completes testing\n\nBlue Harbour AI completed testing at Cyberport with Dr. 陳美玲.",
    );
    await expect(
      rewriteWithFeedback(
        "香港初創Blue Harbour AI表示，已在Cyberport完成測試，項目主管Dr. 陳美玲稱開始日期尚未確定。",
        lowReview,
        englishOutput,
      ),
    ).rejects.toMatchObject({ code: "REWRITE_LANGUAGE_MISMATCH" });
  });

  it("rejects a rewrite that introduces a calculated or localised numeric value", async () => {
    const changedNumber = vi
      .fn()
      .mockResolvedValue("Pilot reaches 350 million records\n\nThe pilot involved 350 million records.");
    await expect(
      rewriteWithFeedback("The pilot involved 3.5 million records.", lowReview, changedNumber),
    ).rejects.toMatchObject({ code: "UNTRACEABLE_REWRITE_NUMBER" });
  });
});
