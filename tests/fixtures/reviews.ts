import type { ReviewModelResponse, ReviewResult } from "@/lib/shared/contracts";

export const lowReviewModelResponse: ReviewModelResponse = {
  overallScore: 41,
  factualCompletenessScore: 52,
  structureScore: 35,
  clarityScore: 38,
  languageQualityScore: 32,
  professionalismScore: 36,
  attributionScore: 48,
  scoreReasons: {
    factualCompleteness:
      "The central announcement is identifiable, but necessary responsibility and timing details are absent.",
    structure: "The draft has no effective lead and moves between ideas without a logical order.",
    clarity: "Fragments, repetition, and vague references make the intended meaning hard to follow.",
    languageQuality: "Frequent grammar and punctuation errors require line-by-line editing.",
    professionalism: "Meta-editing notes and informal wording are unsuitable for publication.",
    attribution: "Several claims are not tied clearly to an identified source.",
  },
  readinessRisks: {
    severelyIncompleteOrUnreliable: false,
    seriousFactualGaps: false,
    unsupportedClaims: false,
    majorStructuralProblems: true,
    veryPoorLanguage: true,
    seriousAttributionOrQuotationProblems: false,
  },
  findings: [
    {
      category: "structure",
      severity: "major",
      issue: "The copy lacks a usable news lead and coherent paragraph sequence.",
      evidence: "The opening consists of fragments and later paragraphs repeat the announcement.",
      recommendation: "Lead with the verified announcement and reorder support in descending importance.",
    },
    {
      category: "languageQuality",
      severity: "major",
      issue: "Sentence construction and mechanics are well below publication standard.",
      evidence: "Multiple fragments, agreement errors, and punctuation errors interrupt comprehension.",
      recommendation: "Rewrite complete sentences and perform a full grammar and punctuation edit.",
    },
  ],
  decision: "REWRITE_REQUIRED",
  strengths: ["The main announcement can be identified."],
  missingInformation: ["The responsible organisation is not identified."],
  recommendations: [
    "Lead with the announcement, identify the responsible organisation, and rebuild the copy in a clear news order.",
  ],
};

export const lowReview: ReviewResult = {
  ...lowReviewModelResponse,
  overallScore: 41,
  weightedScore: 41,
  appliedScoreCap: 59,
  scoreCapReasons: [
    "Major structural problems were identified.",
    "Very poor language quality was identified.",
    "At least one major publication-readiness finding was identified.",
    "At least one category is severely deficient (below 40).",
    "A severe category weakness prevents a high readiness score.",
  ],
  readinessBand: "WEAK",
  decision: "REWRITE_REQUIRED",
};

export const highReviewModelResponse: ReviewModelResponse = {
  overallScore: 91,
  factualCompletenessScore: 91,
  structureScore: 91,
  clarityScore: 91,
  languageQualityScore: 91,
  professionalismScore: 91,
  attributionScore: 91,
  scoreReasons: {
    factualCompleteness: "The central event, material facts, and source support are complete.",
    structure: "The lead and supporting paragraphs follow an effective news order.",
    clarity: "The meaning is precise and easy to follow throughout.",
    languageQuality: "Grammar, punctuation, and sentence mechanics are polished.",
    professionalism: "The copy uses a neutral and publication-ready newsroom style.",
    attribution: "Claims and direct quotations are attributed clearly and consistently.",
  },
  readinessRisks: {
    severelyIncompleteOrUnreliable: false,
    seriousFactualGaps: false,
    unsupportedClaims: false,
    majorStructuralProblems: false,
    veryPoorLanguage: false,
    seriousAttributionOrQuotationProblems: false,
  },
  findings: [],
  decision: "PASS",
  strengths: ["The article is complete, clear, well structured, and professionally attributed."],
  missingInformation: [],
  recommendations: ["[Optional - no score effect] Perform a final fact check before publication."],
};

export const highReview: ReviewResult = {
  ...highReviewModelResponse,
  overallScore: 91,
  weightedScore: 91,
  appliedScoreCap: null,
  scoreCapReasons: [],
  readinessBand: "PUBLICATION_READY",
  decision: "PASS",
};
