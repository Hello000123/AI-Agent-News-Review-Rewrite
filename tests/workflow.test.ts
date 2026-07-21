import { describe, expect, it, vi } from "vitest";

import { parseReviewResponse } from "@/lib/server/agents/review-agent";
import {
  prepareSourceSnapshot,
  reviewDraft,
  rewriteWithFeedback,
} from "@/lib/server/agents/workflow";
import { AppError } from "@/lib/server/errors";
import type { SourceSnapshot } from "@/lib/shared/contracts";
import {
  highReview,
  highReviewModelResponse,
  lowReview,
  lowReviewModelResponse,
} from "@/tests/fixtures/reviews";

function sourceSnapshot(primaryText: string): SourceSnapshot {
  return {
    primaryText,
    userDraft: primaryText,
    imageContext: [],
  };
}

describe("review workflow", () => {
  it("keeps the retrieved headline in a URL-only article snapshot", async () => {
    const snapshot = await prepareSourceSnapshot(
      {
        draft: "",
        sourceUrl: "https://example.com/article",
      },
      {
        dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchImpl: async () =>
          new Response(
            "<html><head><title>Article headline</title></head><body><article><h1>Article headline</h1><p>The council approved a complete, verified and clearly attributed public transport update for residents on Tuesday.</p></article></body></html>",
            { headers: { "content-type": "text/html; charset=utf-8" } },
          ),
      },
    );

    expect(snapshot).toMatchObject({
      primaryText:
        "Article headline\n\nThe council approved a complete, verified and clearly attributed public transport update for residents on Tuesday.",
      userDraft: "",
      sourceUrl: "https://example.com/article",
      linkedTitle: "Article headline",
    });
  });

  it("returns a calibrated failing review and source snapshot after one model call", async () => {
    const completion = vi.fn().mockResolvedValue(JSON.stringify(lowReviewModelResponse));

    const result = await reviewDraft("we got update. more soon.", {
      passScore: 80,
      completionRunner: completion,
    });

    expect(result.review).toEqual(lowReview);
    expect(result.review.decision).toBe("REWRITE_REQUIRED");
    expect(result.review.readinessBand).toBe("WEAK");
    expect(result.source).toEqual({
      primaryText: "we got update. more soon.",
      userDraft: "we got update. more soon.",
      imageContext: [],
    });
    expect(result).not.toHaveProperty("finalText");
    expect(result.message).toContain("below the quality threshold");
    expect(completion).toHaveBeenCalledTimes(1);
    expect(completion.mock.calls[0][0]).toMatchObject({
      responseFormat: "json",
      temperature: 0,
    });
  });

  it("returns a publication-ready review without invoking the Rewrite Agent", async () => {
    const completion = vi.fn().mockResolvedValue(JSON.stringify(highReviewModelResponse));

    const result = await reviewDraft("Acme announced a verified product update.", {
      passScore: 80,
      completionRunner: completion,
    });

    expect(result.review).toEqual(highReview);
    expect(result.review.decision).toBe("PASS");
    expect(result.review.readinessBand).toBe("PUBLICATION_READY");
    expect(result).not.toHaveProperty("finalText");
    expect(result.message).toContain("meets the quality threshold");
    expect(completion).toHaveBeenCalledTimes(1);
    expect(completion.mock.calls[0][0].responseFormat).toBe("json");
  });

  it("recomputes weighted scores, caps, readiness bands, and decisions", () => {
    const parsedHigh = parseReviewResponse(
      JSON.stringify({
        ...highReviewModelResponse,
        overallScore: 12,
        decision: "REWRITE_REQUIRED",
      }),
      80,
    );
    const parsedLow = parseReviewResponse(
      JSON.stringify({ ...lowReviewModelResponse, overallScore: 99, decision: "PASS" }),
      80,
    );

    expect(parsedHigh).toEqual(highReview);
    expect(parsedLow).toEqual(lowReview);
    expect(parsedLow.weightedScore).toBe(41);
    expect(parsedLow.appliedScoreCap).toBe(59);
  });

  it("enforces category scores that are consistent with major findings and risk flags", () => {
    const parsed = parseReviewResponse(
      JSON.stringify({
        ...highReviewModelResponse,
        factualCompletenessScore: 95,
        readinessRisks: {
          ...highReviewModelResponse.readinessRisks,
          seriousFactualGaps: true,
        },
        findings: [
          {
            category: "factualCompleteness",
            severity: "major",
            issue: "Essential opening details are missing.",
            evidence: "The copy omits the location and opening date.",
            recommendation: "Verify and add the missing facts.",
          },
        ],
        missingInformation: ["The location and opening date are absent."],
        recommendations: ["Verify and add the missing facts."],
      }),
      80,
    );

    expect(parsed.factualCompletenessScore).toBe(59);
    expect(parsed.weightedScore).toBe(83);
    expect(parsed.overallScore).toBe(59);
    expect(parsed.appliedScoreCap).toBe(59);
    expect(parsed.readinessBand).toBe("WEAK");
    expect(parsed.decision).toBe("REWRITE_REQUIRED");
    expect(parsed.scoreReasons.factualCompleteness).toContain("Consistency adjustment");
    expect(parsed.scoreReasons.factualCompleteness).toContain("capped at 59");
    expect(parsed.scoreReasons.factualCompleteness).toContain(
      "Essential opening details are missing.",
    );
    expect(parsed.scoreReasons.factualCompleteness).toContain(
      "serious factual gaps were flagged",
    );
    expect(parsed.scoreReasons.factualCompleteness).not.toBe(
      highReviewModelResponse.scoreReasons.factualCompleteness,
    );
    expect(parsed.scoreReasons.structure).toBe(highReviewModelResponse.scoreReasons.structure);
  });

  it("replaces every rationale lowered by a risk-only consistency adjustment", () => {
    const parsed = parseReviewResponse(
      JSON.stringify({
        ...highReviewModelResponse,
        readinessRisks: {
          ...highReviewModelResponse.readinessRisks,
          unsupportedClaims: true,
        },
      }),
      80,
    );

    expect(parsed.factualCompletenessScore).toBe(59);
    expect(parsed.professionalismScore).toBe(59);
    expect(parsed.scoreReasons.factualCompleteness).toContain(
      "material unsupported claims were flagged",
    );
    expect(parsed.scoreReasons.professionalism).toContain(
      "material unsupported claims were flagged",
    );
    expect(parsed.scoreReasons.clarity).toBe(highReviewModelResponse.scoreReasons.clarity);
  });

  it("fails safely on malformed JSON or an incomplete six-category response", () => {
    expect(() => parseReviewResponse("not json", 80)).toThrowError(
      expect.objectContaining({ code: "MALFORMED_REVIEW_JSON" }),
    );
    expect(() =>
      parseReviewResponse(JSON.stringify({ overallScore: 50, structureScore: 50 }), 80),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REVIEW_FORMAT" }));
  });
});

describe("rewrite workflow", () => {
  it("invokes the Rewrite Agent for an explicit request even when the review score is high", async () => {
    const source = sourceSnapshot(
      "Council publishes service update\n\nThe council published a verified service update.",
    );
    const finalText =
      "Council issues verified service update\n\nA verified service update has been published by the council.";
    const completion = vi.fn().mockResolvedValue(finalText);

    const result = await rewriteWithFeedback(source, highReview, completion);

    expect(result).toEqual({
      finalText,
      validation: { status: "passed", attempts: 1 },
    });
    expect(completion).toHaveBeenCalledTimes(1);
    expect(completion.mock.calls[0][0]).toMatchObject({
      responseFormat: "text",
      temperature: 0.1,
    });
    expect(completion.mock.calls[0][0].userPrompt).toContain(
      "explicitly requested a rewrite regardless of review score",
    );
    expect(completion.mock.calls[0][0].userPrompt).toContain(
      '"primaryText": "Council publishes service update',
    );
  });

  it.each([
    ["exact", "Council approves night-bus trial\n\nThe council approved a night-bus trial on Tuesday."],
    [
      "whitespace-only",
      "Council   approves night-bus trial\n\nThe council approved a  night-bus trial on Tuesday.",
    ],
    [
      "punctuation-only",
      "Council approves night-bus trial!\n\nThe council approved a night-bus trial on Tuesday!",
    ],
  ])("retries a %s source echo once and returns the corrected rewrite", async (_label, echo) => {
    const source = sourceSnapshot(
      "Council approves night-bus trial\n\nThe council approved a night-bus trial on Tuesday.",
    );
    const corrected =
      "Council approves night-bus trial\n\nA night-bus trial was approved by the council on Tuesday.";
    const completion = vi.fn().mockResolvedValueOnce(echo).mockResolvedValueOnce(corrected);

    const result = await rewriteWithFeedback(source, lowReview, completion);

    expect(result).toEqual({
      finalText: corrected,
      validation: { status: "passed_after_retry", attempts: 2 },
    });
    expect(completion).toHaveBeenCalledTimes(2);
    expect(completion.mock.calls[1][0].userPrompt).toContain(
      "exact, whitespace-only, or punctuation-only copy",
    );
    expect(completion.mock.calls[1][0].userPrompt).not.toContain(
      "FAILED QUOTATIONS ONLY",
    );
    expect(completion.mock.calls[1][0]).toMatchObject({
      systemPrompt: expect.stringContaining("correcting a failed source echo"),
      temperature: 0,
    });
  });

  it("performs one deterministic-validation correction for malformed output", async () => {
    const source = sourceSnapshot(
      "Council approves night-bus trial\n\nThe council approved a six-week night-bus trial on Tuesday.",
    );
    const malformed = "Council approves night-bus trial";
    const corrected =
      "Council approves six-week night-bus trial\n\nThe council approved the six-week trial on Tuesday.";
    const completion = vi.fn().mockResolvedValueOnce(malformed).mockResolvedValueOnce(corrected);

    const result = await rewriteWithFeedback(source, lowReview, completion);

    expect(result).toEqual({
      finalText: corrected,
      validation: { status: "passed_after_retry", attempts: 2 },
    });
    expect(completion).toHaveBeenCalledTimes(2);
    expect(completion.mock.calls[1][0].userPrompt).toContain("ONE CORRECTION ATTEMPT");
    expect(completion.mock.calls[1][0].userPrompt).toContain("INVALID_REWRITE_FORMAT");
    expect(completion.mock.calls[1][0]).toMatchObject({
      systemPrompt: expect.stringContaining("mechanical news-article format corrector"),
      temperature: 0,
    });
  });

  it("derives a factual headline when the bounded format correction still returns body only", async () => {
    const source = sourceSnapshot(
      "Central Library reported that visits increased last year. Weekend hours will also increase.",
    );
    const firstBodyOnly =
      "Central Library reported that visits increased last year. Weekend hours will also increase.";
    const correctedBodyOnly =
      "Visits to Central Library increased last year. The library will also increase weekend hours.";
    const completion = vi
      .fn()
      .mockResolvedValueOnce(firstBodyOnly)
      .mockResolvedValueOnce(correctedBodyOnly);

    await expect(
      rewriteWithFeedback(source, lowReview, completion),
    ).resolves.toEqual({
      finalText:
        "Visits to Central Library increased last year\n\n" + correctedBodyOnly,
      validation: { status: "passed_after_retry", attempts: 2 },
    });
    expect(completion).toHaveBeenCalledTimes(2);
  });

  it("keeps numeric thousands separators intact when deriving a factual headline", async () => {
    const source = sourceSnapshot(
      "Central Library recorded 448,000 visits last year. Weekend hours will increase.",
    );
    const bodyOnly =
      "Central Library recorded 448,000 visits last year, according to its annual report. Weekend hours will increase.";
    const completion = vi.fn().mockResolvedValue(bodyOnly);

    await expect(
      rewriteWithFeedback(source, lowReview, completion),
    ).resolves.toEqual({
      finalText:
        "Central Library recorded 448,000 visits last year\n\n" + bodyOnly,
      validation: { status: "passed_after_retry", attempts: 2 },
    });
    expect(completion).toHaveBeenCalledTimes(2);
  });

  it("rejects newly invented direct quotations and performs one correction", async () => {
    const source = sourceSnapshot(
      "Council confirms timetable\n\nThe council said the service would begin on Monday.",
    );
    const invented =
      'Council confirms timetable\n\nThe council said, “The service will begin on Monday.”';
    const corrected =
      "Council confirms Monday timetable\n\nThe council said the service would begin on Monday.";
    const completion = vi.fn().mockResolvedValueOnce(invented).mockResolvedValueOnce(corrected);

    await expect(
      rewriteWithFeedback(source, lowReview, completion),
    ).resolves.toEqual({
      finalText: corrected,
      validation: { status: "passed_after_retry", attempts: 2 },
    });
    expect(completion).toHaveBeenCalledTimes(2);
    expect(completion.mock.calls[1][0].userPrompt).toContain(
      "UNTRACEABLE_REWRITE_QUOTATION",
    );
  });

  it("corrects a preserved quotation that was reassigned to a different English named speaker", async () => {
    const source = sourceSnapshot(
      "Council confirms timetable\n\nDirector Mei Wong said, “The service will begin on Monday.”",
    );
    const reassigned =
      "Council confirms Monday timetable\n\nDirector Alex Li said, “The service will begin on Monday.”";
    const corrected =
      "Monday start confirmed\n\nDirector Mei Wong said, “The service will begin on Monday.”";
    const completion = vi
      .fn()
      .mockResolvedValueOnce(reassigned)
      .mockResolvedValueOnce(corrected);

    await expect(
      rewriteWithFeedback(source, lowReview, completion),
    ).resolves.toEqual({
      finalText: corrected,
      validation: { status: "passed_after_retry", attempts: 2 },
    });
    expect(completion).toHaveBeenCalledTimes(2);
    expect(completion.mock.calls[1][0].userPrompt).toContain(
      "REWRITE_ATTRIBUTION_MISMATCH",
    );
    expect(completion.mock.calls[1][0]).toMatchObject({
      systemPrompt: expect.stringContaining("mechanical source-fidelity corrector"),
      temperature: 0,
    });
  });

  it("accepts an unambiguous surname attribution after the full speaker name in the same paragraph", async () => {
    const source = sourceSnapshot(
      "Director Mei Wong said, “The service will begin on Monday.”",
    );
    const candidate =
      "Monday service start confirmed\n\nDirector Mei Wong announced the timetable. “The service will begin on Monday.” Wong stated.";
    const completion = vi.fn().mockResolvedValue(candidate);

    await expect(
      rewriteWithFeedback(source, lowReview, completion),
    ).resolves.toEqual({
      finalText: candidate,
      validation: { status: "passed", attempts: 1 },
    });
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it("reuses the safe first headline when a focused attribution correction returns body only", async () => {
    const source = sourceSnapshot(
      "Central Library said visits increased. Director Mei Wong said, “Longer hours begin Monday.”",
    );
    const reassigned =
      "Library extends opening hours\n\nCentral Library said visits increased. Director Alex Li said, “Longer hours begin Monday.”";
    const correctedBody =
      "Central Library said visits increased. Director Mei Wong said, “Longer hours begin Monday.”";
    const completion = vi
      .fn()
      .mockResolvedValueOnce(reassigned)
      .mockResolvedValueOnce(correctedBody);

    await expect(
      rewriteWithFeedback(source, lowReview, completion),
    ).resolves.toEqual({
      finalText: `Library extends opening hours\n\n${correctedBody}`,
      validation: { status: "passed_after_retry", attempts: 2 },
    });
    expect(completion).toHaveBeenCalledTimes(2);
  });

  it("stops after one correction when a Chinese named-speaker reassignment persists", async () => {
    const source = sourceSnapshot(
      "議會公布服務安排\n\n王美玲表示：「服務將於星期一開始。」",
    );
    const reassigned =
      "議會公布星期一安排\n\n李志明表示：「服務將於星期一開始。」王美玲亦出席會議。";
    const secondReassigned =
      "星期一服務安排公布\n\n李志明稱：「服務將於星期一開始。」王美玲會後離開。";
    const completion = vi
      .fn()
      .mockResolvedValueOnce(reassigned)
      .mockResolvedValueOnce(secondReassigned);

    let failure: AppError | undefined;
    try {
      await rewriteWithFeedback(source, lowReview, completion);
    } catch (error) {
      failure = error as AppError;
    }

    expect(completion).toHaveBeenCalledTimes(2);
    expect(failure).toMatchObject({
      code: "REWRITE_ATTRIBUTION_MISMATCH",
      status: 422,
      publicDetails: {
        retryable: true,
        attempts: 2,
        candidateText: secondReassigned,
      },
    });
    expect(failure?.publicDetails?.details).toEqual(
      expect.arrayContaining([
        expect.stringContaining("王美玲"),
        expect.stringContaining("李志明"),
        expect.stringContaining("retry"),
      ]),
    );
  });

  it("does not mistake an unattributed quoted editorial label for direct speech", async () => {
    const source = sourceSnapshot(
      "Results update\n\nThe school named a super top scorer.",
    );
    const candidate =
      "School reports results\n\nThe school named a “super top scorer.” in its results update.";
    const completion = vi.fn().mockResolvedValue(candidate);

    await expect(
      rewriteWithFeedback(source, lowReview, completion),
    ).resolves.toEqual({
      finalText: candidate,
      validation: { status: "passed", attempts: 1 },
    });
  });

  it("accepts exact Chinese-unit conversions in a Chinese rewrite", async () => {
    const source = sourceSnapshot(
      "DSE results set a record\n\n今年共有5.8萬名考生，當中24人成為狀元；羅每周訓練3至4小時。",
    );
    const rewritten =
      "DSE成績創紀錄\n\n今年共有58,000名考生獲發成績，其中24人成為狀元；羅每周訓練3至4小時。";
    const completion = vi.fn().mockResolvedValue(rewritten);

    await expect(
      rewriteWithFeedback(source, lowReview, completion),
    ).resolves.toEqual({
      finalText: rewritten,
      validation: { status: "passed", attempts: 1 },
    });
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it("retries when a rewrite romanizes a required Chinese person name", async () => {
    const source = sourceSnapshot(
      "Results released\n\n王繹嘉表示，他計劃留港升學。",
    );
    const romanized =
      "成績公布\n\nWong Yik-ka表示，他計劃留港升學。";
    const corrected =
      "成績公布\n\n王繹嘉表示，他計劃留港升學。";
    const completion = vi.fn().mockResolvedValueOnce(romanized).mockResolvedValueOnce(corrected);

    await expect(
      rewriteWithFeedback(source, lowReview, completion),
    ).resolves.toEqual({
      finalText: corrected,
      validation: { status: "passed_after_retry", attempts: 2 },
    });
    expect(completion.mock.calls[1][0].userPrompt).toContain("INEXACT_SOURCE_SCRIPT_NAME");
    expect(completion.mock.calls[1][0].userPrompt).toContain("王繹嘉");
    expect(completion.mock.calls[1][0]).toMatchObject({
      systemPrompt: expect.stringContaining("mechanical source-fidelity corrector"),
      temperature: 0,
    });
  });

  it("performs one bounded quotation-correction retry and returns the corrected draft", async () => {
    const source = sourceSnapshot(
      "Council confirms timetable\n\nA spokesperson said, “The service will begin on 1 August.”",
    );
    const firstCandidate =
      "Council confirms timetable\n\nA spokesperson said, “The service will start on 1 August.”";
    const corrected =
      "Council confirms 1 August start\n\nA spokesperson said, “The service will begin on 1 August.”";
    const completion = vi
      .fn()
      .mockResolvedValueOnce(firstCandidate)
      .mockResolvedValueOnce(corrected);

    const result = await rewriteWithFeedback(source, lowReview, completion);

    expect(result).toEqual({
      finalText: corrected,
      validation: { status: "passed_after_retry", attempts: 2 },
    });
    expect(completion).toHaveBeenCalledTimes(2);
    expect(completion.mock.calls[1][0].userPrompt).toContain("FAILED QUOTATIONS ONLY");
    expect(completion.mock.calls[1][0]).toMatchObject({
      systemPrompt: expect.stringContaining("mechanical quotation-fidelity corrector"),
      temperature: 0,
    });
    expect(completion.mock.calls[1][0].userPrompt).toContain(
      "“The service will begin on 1 August.”",
    );
    expect(completion.mock.calls[1][0].userPrompt).not.toContain(
      "The service will start on 1 August.\"\n  },",
    );
  });

  it("safely repairs punctuation-only quotation changes after the bounded retry", async () => {
    const source = sourceSnapshot(
      "Council confirms plan\n\n發言人說：「安排維持不變」",
    );
    const firstCandidate =
      "Council confirms plan\n\n發言人說：“安排已經改變。”";
    const punctuationOnlyCandidate =
      'Council confirms unchanged plan\n\n發言人說:"安排維持不變,"';
    const completion = vi
      .fn()
      .mockResolvedValueOnce(firstCandidate)
      .mockResolvedValueOnce(punctuationOnlyCandidate);

    await expect(
      rewriteWithFeedback(source, lowReview, completion),
    ).resolves.toEqual({
      finalText: "Council confirms unchanged plan\n\n發言人說:「安排維持不變」",
      validation: { status: "passed_after_retry", attempts: 2 },
    });
    expect(completion).toHaveBeenCalledTimes(2);
  });

  it("stops after one failed quotation retry and retains structured candidate diagnostics", async () => {
    const source = sourceSnapshot(
      "Council confirms timetable\n\nA spokesperson said, “The service will begin on 1 August.”",
    );
    const firstCandidate =
      "Council confirms timetable\n\nA spokesperson said, “The service will start on 1 August.”";
    const secondCandidate =
      "Council confirms 1 August start\n\nA spokesperson said, “The service will commence on 1 August.”";
    const completion = vi
      .fn()
      .mockResolvedValueOnce(firstCandidate)
      .mockResolvedValueOnce(secondCandidate);

    let failure: AppError | undefined;
    try {
      await rewriteWithFeedback(source, lowReview, completion);
    } catch (error) {
      failure = error as AppError;
    }

    expect(completion).toHaveBeenCalledTimes(2);
    expect(failure).toMatchObject({
      code: "INEXACT_REWRITE_QUOTATION",
      status: 422,
      publicDetails: {
        retryable: true,
        attempts: 2,
        candidateText: secondCandidate,
        quotationIssues: [
          {
            kind: "modified",
            original: "“The service will begin on 1 August.”",
            rewrite: "“The service will commence on 1 August.”",
            sourceParagraph: 2,
            rewriteParagraph: 2,
          },
        ],
      },
    });
    const quotationIssue = failure?.publicDetails?.quotationIssues?.[0];
    expect(quotationIssue?.sourceExcerpt).toContain("A spokesperson said");
    expect(quotationIssue?.differenceSummary).toContain("character");
    expect(quotationIssue?.action).toContain("Restore the source quotation exactly");
  });

  it("stops after one unchanged correction attempt and retains that candidate", async () => {
    const source = sourceSnapshot(
      "Council approves night-bus trial\n\nThe council approved a night-bus trial on Tuesday.",
    );
    const completion = vi.fn().mockResolvedValue(source.primaryText);

    let failure: AppError | undefined;
    try {
      await rewriteWithFeedback(source, lowReview, completion);
    } catch (error) {
      failure = error as AppError;
    }

    expect(completion).toHaveBeenCalledTimes(2);
    expect(failure).toMatchObject({
      code: "UNCHANGED_REWRITE",
      status: 422,
      publicDetails: {
        retryable: true,
        attempts: 2,
        candidateText: source.primaryText,
      },
    });
  });

  it("removes a lone markdown fence and returns the RewriteApiResponse contract", async () => {
    const source = sourceSnapshot("Original headline\n\nOriginal supported facts.");
    const fenced =
      "\x60\x60\x60text\nConcise headline\n\nA clearer account of the supported facts.\n\x60\x60\x60";
    const completion = vi.fn().mockResolvedValue(fenced);

    await expect(
      rewriteWithFeedback(source, lowReview, completion),
    ).resolves.toEqual({
      finalText: "Concise headline\n\nA clearer account of the supported facts.",
      validation: { status: "passed", attempts: 1 },
    });
  });
});
