import {
  deepSeekPublicDiagnostics,
  requestDeepSeekCompletion,
  type CompletionRequest,
} from "@/lib/server/agents/deepseek-client";
import {
  createReviewSystemPrompt,
  createReviewUserPrompt,
} from "@/lib/server/agents/prompts";
import { AppError } from "@/lib/server/errors";
import {
  calculateWeightedScore,
  readinessBandForScore,
  reviewModelResponseSchema,
  reviewResultSchema,
  type ReviewResult,
  type ReviewFinding,
  type SourceSnapshot,
} from "@/lib/shared/contracts";

export type CompletionRunner = (request: CompletionRequest) => Promise<string>;

type ParsedReview = ReturnType<typeof reviewModelResponseSchema.parse>;
type ScoreKey =
  | "factualCompletenessScore"
  | "structureScore"
  | "clarityScore"
  | "languageQualityScore"
  | "professionalismScore"
  | "attributionScore";

type ScoreReasonKey = keyof ParsedReview["scoreReasons"];

const scoreReasonKey: Record<ScoreKey, ScoreReasonKey> = {
  factualCompletenessScore: "factualCompleteness",
  structureScore: "structure",
  clarityScore: "clarity",
  languageQualityScore: "languageQuality",
  professionalismScore: "professionalism",
  attributionScore: "attribution",
};

const scoreLabel: Record<ScoreKey, string> = {
  factualCompletenessScore: "factual completeness and support",
  structureScore: "structure and logical flow",
  clarityScore: "clarity and readability",
  languageQualityScore: "grammar and language quality",
  professionalismScore: "news-writing professionalism",
  attributionScore: "attribution and quotation handling",
};

const findingScoreKey: Record<ReviewFinding["category"], ScoreKey> = {
  factualCompleteness: "factualCompletenessScore",
  structure: "structureScore",
  clarity: "clarityScore",
  languageQuality: "languageQualityScore",
  professionalism: "professionalismScore",
  attribution: "attributionScore",
};

const findingScoreCap: Record<ReviewFinding["severity"], number> = {
  critical: 39,
  major: 59,
  moderate: 74,
  minor: 89,
};

function consistencyRiskReasons(review: ParsedReview, key: ScoreKey) {
  const risks = review.readinessRisks;
  const reasons: string[] = [];

  if (key === "factualCompletenessScore") {
    if (risks.severelyIncompleteOrUnreliable) {
      reasons.push("the draft was flagged as severely incomplete or unreliable");
    }
    if (risks.seriousFactualGaps) reasons.push("serious factual gaps were flagged");
    if (risks.unsupportedClaims) reasons.push("material unsupported claims were flagged");
  }
  if (key === "structureScore" && risks.majorStructuralProblems) {
    reasons.push("major structural problems were flagged");
  }
  if (key === "languageQualityScore" && risks.veryPoorLanguage) {
    reasons.push("very poor language quality was flagged");
  }
  if (key === "professionalismScore" && risks.unsupportedClaims) {
    reasons.push("material unsupported claims were flagged");
  }
  if (key === "attributionScore" && risks.seriousAttributionOrQuotationProblems) {
    reasons.push("serious attribution or quotation problems were flagged");
  }

  return reasons;
}

function consistencyScoreReason(review: ParsedReview, key: ScoreKey, adjustedScore: number) {
  const relevantFindings = review.findings
    .filter((finding) => findingScoreKey[finding.category] === key)
    .map((finding) => `${finding.severity} finding: ${finding.issue}`);
  const evidence = [...relevantFindings, ...consistencyRiskReasons(review, key)];
  const explanation = evidence.length > 0 ? evidence.join("; ") : "a deterministic score cap applies";
  const reason =
    `Consistency adjustment: ${scoreLabel[key]} is capped at ${adjustedScore} because ${explanation}. ` +
    "This adjusted rationale supersedes the model's higher category assessment.";

  // scoreReasons are part of the public contract and are limited to 800
  // characters. Findings are independently bounded but several may apply to
  // one category, so keep this deterministic rationale inside that contract.
  return reason.length <= 800 ? reason : `${reason.slice(0, 797)}...`;
}

function enforceCategoryConsistency(review: ParsedReview): ParsedReview {
  const scores: Record<ScoreKey, number> = {
    factualCompletenessScore: review.factualCompletenessScore,
    structureScore: review.structureScore,
    clarityScore: review.clarityScore,
    languageQualityScore: review.languageQualityScore,
    professionalismScore: review.professionalismScore,
    attributionScore: review.attributionScore,
  };
  const capScore = (key: ScoreKey, cap: number) => {
    scores[key] = Math.min(scores[key], cap);
  };

  for (const finding of review.findings) {
    capScore(findingScoreKey[finding.category], findingScoreCap[finding.severity]);
  }

  const risks = review.readinessRisks;
  if (risks.severelyIncompleteOrUnreliable) capScore("factualCompletenessScore", 39);
  if (risks.seriousFactualGaps) capScore("factualCompletenessScore", 59);
  if (risks.unsupportedClaims) {
    capScore("factualCompletenessScore", 59);
    capScore("professionalismScore", 59);
  }
  if (risks.majorStructuralProblems) capScore("structureScore", 59);
  if (risks.veryPoorLanguage) capScore("languageQualityScore", 59);
  if (risks.seriousAttributionOrQuotationProblems) capScore("attributionScore", 59);

  const scoreReasons = { ...review.scoreReasons };
  for (const key of Object.keys(scores) as ScoreKey[]) {
    if (scores[key] < review[key]) {
      scoreReasons[scoreReasonKey[key]] = consistencyScoreReason(review, key, scores[key]);
    }
  }

  return { ...review, ...scores, scoreReasons };
}

function applyScoreCaps(review: ParsedReview) {
  let cap: number | null = null;
  const reasons: string[] = [];

  function addCap(value: number, reason: string) {
    cap = cap === null ? value : Math.min(cap, value);
    if (!reasons.includes(reason)) reasons.push(reason);
  }

  if (review.readinessRisks.severelyIncompleteOrUnreliable) {
    addCap(39, "The draft was marked severely incomplete or unreliable.");
  }
  if (review.findings.some(({ severity }) => severity === "critical")) {
    addCap(39, "At least one critical publication-readiness finding was identified.");
  }

  const seriousRiskLabels = [
    [review.readinessRisks.seriousFactualGaps, "Serious factual gaps were identified."],
    [review.readinessRisks.unsupportedClaims, "Material unsupported claims were identified."],
    [review.readinessRisks.majorStructuralProblems, "Major structural problems were identified."],
    [review.readinessRisks.veryPoorLanguage, "Very poor language quality was identified."],
    [
      review.readinessRisks.seriousAttributionOrQuotationProblems,
      "Serious attribution or quotation problems were identified.",
    ],
  ] as const;
  for (const [present, reason] of seriousRiskLabels) {
    if (present) addCap(59, reason);
  }
  if (review.findings.some(({ severity }) => severity === "major")) {
    addCap(59, "At least one major publication-readiness finding was identified.");
  }
  if (review.findings.some(({ severity }) => severity === "moderate")) {
    addCap(74, "At least one moderate finding requires substantial editing.");
  }
  if (review.findings.some(({ severity }) => severity === "minor")) {
    addCap(89, "At least one material minor finding remains.");
  }

  const categoryScores = [
    review.factualCompletenessScore,
    review.structureScore,
    review.clarityScore,
    review.languageQualityScore,
    review.professionalismScore,
    review.attributionScore,
  ];
  const lowestCategory = Math.min(...categoryScores);
  if (lowestCategory < 40) {
    addCap(59, "At least one category is severely deficient (below 40).");
    addCap(59, "A severe category weakness prevents a high readiness score.");
  } else if (lowestCategory < 60) {
    addCap(74, "At least one category is below 60 and requires substantial editing.");
  } else if (lowestCategory < 75) {
    addCap(89, "At least one category is below the strong-copy anchor of 75.");
  }

  if (review.missingInformation.length > 0 && review.findings.length === 0) {
    addCap(74, "Necessary information was listed without a corresponding finding.");
  }
  if (
    review.recommendations.some((item) => !item.startsWith("[Optional - no score effect]")) &&
    review.findings.length === 0
  ) {
    addCap(89, "A non-optional recommendation remains despite no structured finding.");
  }

  return { cap, reasons };
}

export function parseReviewResponse(content: string, passScore: number): ReviewResult {
  let rawReview: unknown;
  try {
    rawReview = JSON.parse(content);
  } catch (error) {
    throw new AppError(
      "MALFORMED_REVIEW_JSON",
      "The Review Agent returned invalid JSON. Please try the review again.",
      502,
      {
        cause: error,
        publicDetails: deepSeekPublicDiagnostics(
          "review_request",
          200,
          "DeepSeek's final answer was not valid review JSON.",
          true,
        ),
      },
    );
  }

  const parsed = reviewModelResponseSchema.safeParse(rawReview);
  if (!parsed.success) {
    throw new AppError(
      "INVALID_REVIEW_FORMAT",
      "The Review Agent returned an incomplete assessment. Please try the review again.",
      502,
      {
        publicDetails: deepSeekPublicDiagnostics(
          "review_request",
          200,
          "DeepSeek's final JSON answer did not match the required review schema.",
          true,
        ),
      },
    );
  }

  const consistentReview = enforceCategoryConsistency(parsed.data);
  const weightedScore = calculateWeightedScore(consistentReview);
  const { cap, reasons: scoreCapReasons } = applyScoreCaps(consistentReview);
  const overallScore = Math.min(weightedScore, cap ?? 100);
  return reviewResultSchema.parse({
    ...consistentReview,
    overallScore,
    weightedScore,
    appliedScoreCap: cap,
    scoreCapReasons,
    readinessBand: readinessBandForScore(overallScore),
    decision: overallScore >= passScore ? "PASS" : "REWRITE_REQUIRED",
  });
}

export async function runReviewAgent(
  source: SourceSnapshot | string,
  passScore: number,
  completionRunner: CompletionRunner = requestDeepSeekCompletion,
) {
  const content = await completionRunner({
    stage: "review_request",
    systemPrompt: createReviewSystemPrompt(passScore),
    userPrompt: createReviewUserPrompt(source),
    responseFormat: "json",
    maxTokens: 64_000,
    // Reviews should be as repeatable as the provider allows; rewriting remains
    // separately configured for natural prose generation.
    temperature: 0,
  });

  return parseReviewResponse(content, passScore);
}
