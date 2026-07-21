import { describe, expect, it } from "vitest";

import {
  REVIEW_SCORE_WEIGHTS,
  calculateWeightedScore,
  editorialInputSchema,
  readinessBandForScore,
  reviewResultSchema,
  type ReviewCategoryScores,
  type ReviewFinding,
  type ReviewResult,
} from "@/lib/shared/contracts";
import {
  EVALUATION_REVIEW_SCORE_WEIGHTS,
  ORIENTAL_DSE_ARTICLE_URL,
  calculateEvaluationWeightedScore,
  evaluateReviewComparisons,
  evaluateReviewResult,
  evaluateReviewRuns,
  evaluationReadinessBandForScore,
  reviewEvaluationCases,
  reviewEvaluationComparisons,
} from "@/tests/fixtures/review-evaluation";

const defaultScores: ReviewCategoryScores = {
  factualCompletenessScore: 94,
  structureScore: 94,
  clarityScore: 94,
  languageQualityScore: 94,
  professionalismScore: 94,
  attributionScore: 94,
};

const defaultRisks: ReviewResult["readinessRisks"] = {
  severelyIncompleteOrUnreliable: false,
  seriousFactualGaps: false,
  unsupportedClaims: false,
  majorStructuralProblems: false,
  veryPoorLanguage: false,
  seriousAttributionOrQuotationProblems: false,
};

function finding(
  category: ReviewFinding["category"],
  severity: ReviewFinding["severity"] = "major",
): ReviewFinding {
  return {
    category,
    severity,
    issue: "A material publication-readiness weakness is present.",
    evidence: "The submitted copy contains evidence of the identified weakness.",
    recommendation: "Correct the weakness before publication.",
  };
}

function makeReviewResult(
  options: {
    scores?: Partial<ReviewCategoryScores>;
    risks?: Partial<ReviewResult["readinessRisks"]>;
    findings?: ReviewFinding[];
    missingInformation?: string[];
    appliedScoreCap?: number | null;
    overallScore?: number;
    weightedScore?: number;
    readinessBand?: ReviewResult["readinessBand"];
    decision?: ReviewResult["decision"];
  } = {},
): ReviewResult {
  const scores = { ...defaultScores, ...options.scores };
  const weightedScore = options.weightedScore ?? calculateWeightedScore(scores);
  const appliedScoreCap = options.appliedScoreCap ?? null;
  const overallScore =
    options.overallScore ?? Math.min(weightedScore, appliedScoreCap ?? 100);
  return {
    ...scores,
    overallScore,
    weightedScore,
    appliedScoreCap,
    scoreCapReasons:
      appliedScoreCap === null ? [] : ["A deterministic publication-readiness cap applies."],
    readinessBand: options.readinessBand ?? readinessBandForScore(overallScore),
    decision: options.decision ?? (overallScore >= 80 ? "PASS" : "REWRITE_REQUIRED"),
    scoreReasons: {
      factualCompleteness: "The score reflects completeness, support and traceability.",
      structure: "The score reflects lead quality, order and logical flow.",
      clarity: "The score reflects precision and readability.",
      languageQuality: "The score reflects grammar, syntax and punctuation.",
      professionalism: "The score reflects neutral, publication-ready news writing.",
      attribution: "The score reflects sourcing and quotation handling.",
    },
    readinessRisks: { ...defaultRisks, ...options.risks },
    findings: options.findings ?? [],
    strengths: ["The central event can be assessed from the submitted copy."],
    missingInformation: options.missingInformation ?? [],
    recommendations:
      options.findings?.length || options.missingInformation?.length
        ? ["Resolve the structured findings before publication."]
        : ["[Optional - no score effect] Complete a final source check before publication."],
  };
}

function expectedResultForCase(id: string) {
  switch (id) {
    case "oriental_dse_2026_live_url":
      return makeReviewResult({
        scores: {
          factualCompletenessScore: 84,
          structureScore: 84,
          clarityScore: 84,
          languageQualityScore: 84,
          professionalismScore: 84,
          attributionScore: 84,
        },
      });
    case "traditional_poor_draft":
    case "english_poor_draft":
      return makeReviewResult({
        scores: {
          factualCompletenessScore: 55,
          structureScore: 45,
          clarityScore: 50,
          languageQualityScore: 42,
          professionalismScore: 40,
          attributionScore: 55,
        },
        risks: { majorStructuralProblems: true, veryPoorLanguage: true },
        findings: [finding("structure")],
        appliedScoreCap: 59,
      });
    case "traditional_poor_draft_with_publisher_reference":
      return makeReviewResult({
        scores: {
          factualCompletenessScore: 30,
          structureScore: 30,
          clarityScore: 35,
          languageQualityScore: 35,
          professionalismScore: 30,
          attributionScore: 45,
        },
        risks: { severelyIncompleteOrUnreliable: true, majorStructuralProblems: true },
        findings: [finding("structure", "critical")],
        appliedScoreCap: 39,
      });
    case "traditional_high_quality":
      return makeReviewResult({
        scores: {
          factualCompletenessScore: 88,
          structureScore: 86,
          clarityScore: 88,
          languageQualityScore: 88,
          professionalismScore: 86,
          attributionScore: 86,
        },
        findings: [finding("structure", "minor")],
        appliedScoreCap: 89,
      });
    case "missing_core_facts":
      return makeReviewResult({
        scores: {
          factualCompletenessScore: 45,
          structureScore: 75,
          clarityScore: 80,
          languageQualityScore: 85,
          professionalismScore: 80,
          attributionScore: 45,
        },
        risks: { seriousFactualGaps: true },
        findings: [finding("factualCompleteness")],
        missingInformation: ["The responsible organisation, location and opening date are absent."],
        appliedScoreCap: 59,
      });
    case "unsupported_material_claims":
      return makeReviewResult({
        scores: {
          factualCompletenessScore: 55,
          structureScore: 85,
          clarityScore: 85,
          languageQualityScore: 90,
          professionalismScore: 55,
          attributionScore: 45,
        },
        risks: { unsupportedClaims: true },
        findings: [finding("factualCompleteness", "major")],
        appliedScoreCap: 59,
      });
    case "severely_unreliable_fragment":
      return makeReviewResult({
        scores: {
          factualCompletenessScore: 25,
          structureScore: 30,
          clarityScore: 30,
          languageQualityScore: 40,
          professionalismScore: 20,
          attributionScore: 20,
        },
        risks: { severelyIncompleteOrUnreliable: true, unsupportedClaims: true },
        findings: [finding("factualCompleteness", "critical")],
        appliedScoreCap: 39,
      });
    case "traditional_multiple_quotation_styles":
      return makeReviewResult({
        scores: {
          factualCompletenessScore: 88,
          structureScore: 86,
          clarityScore: 88,
          languageQualityScore: 88,
          professionalismScore: 86,
          attributionScore: 92,
        },
        findings: [finding("structure", "minor")],
        appliedScoreCap: 89,
      });
    default:
      return makeReviewResult();
  }
}

describe("review scoring evaluation set", () => {
  it("covers the requested quality, language, risk and live-URL cases", () => {
    expect(reviewEvaluationCases).toHaveLength(10);
    expect(new Set(reviewEvaluationCases.map(({ id }) => id)).size).toBe(
      reviewEvaluationCases.length,
    );

    const tags = new Set(reviewEvaluationCases.flatMap(({ tags }) => tags));
    for (const tag of [
      "traditional_chinese",
      "english",
      "high_quality",
      "poor_draft",
      "missing_facts",
      "unsupported_claims",
      "severely_deficient",
      "publisher_independence",
      "multiple_quotations",
      "chinese_punctuation",
      "live_url",
    ]) {
      expect(tags).toContain(tag);
    }

    const liveUrlCase = reviewEvaluationCases.find(
      ({ id }) => id === "oriental_dse_2026_live_url",
    );
    expect(liveUrlCase?.request).toMatchObject({
      draft: "",
      sourceUrl: ORIENTAL_DSE_ARTICLE_URL,
    });
    expect(liveUrlCase?.inputKind).toBe("url");

    const publisherControl = reviewEvaluationCases.find(
      ({ id }) => id === "traditional_poor_draft_with_publisher_reference",
    );
    expect(publisherControl?.request).toMatchObject({
      sourceUrl: ORIENTAL_DSE_ARTICLE_URL,
    });
    expect(publisherControl?.request.draft.trim()).not.toBe("");
    expect(publisherControl?.request.draft).toContain("24");
    expect(publisherControl?.request.draft).toContain("42");
    expect(publisherControl?.request.draft).toContain("20人定2人");
    expect(publisherControl?.request.draft).toContain("未核實");
    expect(publisherControl?.request.draft).toContain("唔可以刊登");
    expect(publisherControl?.expected.requiredRisks).toMatchObject({
      severelyIncompleteOrUnreliable: true,
      majorStructuralProblems: true,
    });
    expect(publisherControl?.inputKind).toBe("text_with_reference");
  });

  it("keeps every request and constructed expected result inside current contracts", () => {
    for (const testCase of reviewEvaluationCases) {
      expect(editorialInputSchema.safeParse(testCase.request).success, testCase.id).toBe(true);
      const expectedResult = expectedResultForCase(testCase.id);
      expect(reviewResultSchema.safeParse(expectedResult).success, testCase.id).toBe(true);
      expect(evaluateReviewResult(testCase, expectedResult, 80), testCase.id).toEqual({
        passed: true,
        failures: [],
      });
    }
  });

  it("keeps evaluation math and readiness bands aligned with production contracts", () => {
    expect(EVALUATION_REVIEW_SCORE_WEIGHTS).toEqual(REVIEW_SCORE_WEIGHTS);
    expect(calculateEvaluationWeightedScore(defaultScores)).toBe(
      calculateWeightedScore(defaultScores),
    );
    for (const score of [0, 39, 40, 59, 60, 74, 75, 89, 90, 100]) {
      expect(evaluationReadinessBandForScore(score)).toBe(readinessBandForScore(score));
    }
  });

  it("requires expected ranges, bands, categories, risks, caps and findings", () => {
    const highCase = reviewEvaluationCases.find(({ id }) => id === "english_high_quality")!;
    const cappedHigh = makeReviewResult({
      appliedScoreCap: 89,
      overallScore: 89,
      readinessBand: "STRONG_LIMITED_EDITING",
      decision: "PASS",
    });
    const highResult = evaluateReviewResult(highCase, cappedHigh, 80);
    expect(highResult.passed).toBe(false);
    expect(highResult.failures).toEqual(
      expect.arrayContaining([
        "overallScore 89 is outside expected range 90-100.",
        "readinessBand STRONG_LIMITED_EDITING does not match expected PUBLICATION_READY.",
        "Expected no score cap, but cap 89 was applied.",
      ]),
    );

    const unsupportedCase = reviewEvaluationCases.find(
      ({ id }) => id === "unsupported_material_claims",
    )!;
    const unflagged = makeReviewResult({
      scores: { factualCompletenessScore: 59, attributionScore: 59 },
      findings: [finding("factualCompleteness")],
      appliedScoreCap: 59,
    });
    expect(evaluateReviewResult(unsupportedCase, unflagged).failures).toContain(
      "readinessRisks.unsupportedClaims must be true.",
    );
  });

  it("detects inconsistent weighted, capped and decision values", () => {
    const testCase = reviewEvaluationCases.find(
      ({ id }) => id === "unsupported_material_claims",
    )!;
    const inconsistent = makeReviewResult({
      scores: { factualCompletenessScore: 55, attributionScore: 45 },
      risks: { unsupportedClaims: true },
      findings: [finding("factualCompleteness")],
      appliedScoreCap: 59,
      weightedScore: 88,
      overallScore: 60,
      readinessBand: "SUBSTANTIAL_REWRITE",
      decision: "PASS",
    });
    const result = evaluateReviewResult(testCase, inconsistent, 80);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes("does not match recomputed score"))).toBe(
      true,
    );
    expect(
      result.failures.some((failure) => failure.includes("does not match weighted/capped score")),
    ).toBe(true);
    expect(result.failures.some((failure) => failure.includes("inconsistent with pass score"))).toBe(
      true,
    );
  });

  it("gates repeated-run stability for overall and category scores", () => {
    const testCase = reviewEvaluationCases.find(({ id }) => id === "english_high_quality")!;
    const stable = evaluateReviewRuns(
      testCase,
      [
        makeReviewResult({ scores: Object.fromEntries(Object.keys(defaultScores).map((key) => [key, 92])) }),
        makeReviewResult({ scores: Object.fromEntries(Object.keys(defaultScores).map((key) => [key, 98])) }),
      ],
      2,
      80,
    );
    expect(stable.passed).toBe(true);
    expect(stable.overallSpread).toBe(6);
    expect(stable.medianOverallScore).toBe(95);

    const unstable = evaluateReviewRuns(
      testCase,
      [
        makeReviewResult({ scores: Object.fromEntries(Object.keys(defaultScores).map((key) => [key, 90])) }),
        makeReviewResult({ scores: Object.fromEntries(Object.keys(defaultScores).map((key) => [key, 99])) }),
      ],
      2,
    );
    expect(unstable.passed).toBe(false);
    expect(unstable.failures).toContain("Overall score spread 9 exceeds 8.");
  });

  it("requires strong drafts to outscore poor drafts in both languages", () => {
    expect(reviewEvaluationComparisons).toHaveLength(2);
    expect(
      evaluateReviewComparisons({
        traditional_high_quality: 94,
        traditional_poor_draft: 52,
        english_high_quality: 93,
        english_poor_draft: 50,
      }),
    ).toEqual({ passed: true, failures: [] });

    const failed = evaluateReviewComparisons({
      traditional_high_quality: 78,
      traditional_poor_draft: 60,
      english_high_quality: 80,
      english_poor_draft: 58,
    });
    expect(failed.passed).toBe(false);
    expect(failed.failures).toHaveLength(2);
  });
});
