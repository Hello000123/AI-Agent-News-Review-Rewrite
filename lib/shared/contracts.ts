import { z } from "zod";

export const MAX_DRAFT_CHARS = 50_000;
export const MAX_REFERENCE_CHARS = 50_000;
export const MAX_REQUEST_BYTES = 220_000;
export const MAX_SOURCE_URL_CHARS = 2_048;
export const MAX_IMAGE_CONTEXT_ITEMS = 8;

export const REVIEW_SCORE_WEIGHTS = {
  factualCompletenessScore: 0.25,
  structureScore: 0.2,
  clarityScore: 0.15,
  languageQualityScore: 0.15,
  professionalismScore: 0.15,
  attributionScore: 0.1,
} as const;

export const reviewCategorySchema = z.enum([
  "factualCompleteness",
  "structure",
  "clarity",
  "languageQuality",
  "professionalism",
  "attribution",
]);
export type ReviewCategory = z.infer<typeof reviewCategorySchema>;

export const reviewSeveritySchema = z.enum(["minor", "moderate", "major", "critical"]);
export type ReviewSeverity = z.infer<typeof reviewSeveritySchema>;

export const readinessBandSchema = z.enum([
  "PUBLICATION_READY",
  "STRONG_LIMITED_EDITING",
  "SUBSTANTIAL_REWRITE",
  "WEAK",
  "SEVERELY_DEFICIENT",
]);
export type ReadinessBand = z.infer<typeof readinessBandSchema>;

const scoreSchema = z.number().finite().min(0).max(100);
const feedbackItemSchema = z.string().trim().min(1).max(800);
const sourceTextSchema = z.string().max(MAX_REFERENCE_CHARS);

export type ReviewCategoryScores = Record<keyof typeof REVIEW_SCORE_WEIGHTS, number>;

export function calculateWeightedScore(scores: ReviewCategoryScores) {
  return Math.round(
    scores.factualCompletenessScore * REVIEW_SCORE_WEIGHTS.factualCompletenessScore +
      scores.structureScore * REVIEW_SCORE_WEIGHTS.structureScore +
      scores.clarityScore * REVIEW_SCORE_WEIGHTS.clarityScore +
      scores.languageQualityScore * REVIEW_SCORE_WEIGHTS.languageQualityScore +
      scores.professionalismScore * REVIEW_SCORE_WEIGHTS.professionalismScore +
      scores.attributionScore * REVIEW_SCORE_WEIGHTS.attributionScore,
  );
}

export function readinessBandForScore(score: number): ReadinessBand {
  if (score >= 90) return "PUBLICATION_READY";
  if (score >= 75) return "STRONG_LIMITED_EDITING";
  if (score >= 60) return "SUBSTANTIAL_REWRITE";
  if (score >= 40) return "WEAK";
  return "SEVERELY_DEFICIENT";
}

const scoreReasonsSchema = z
  .object({
    factualCompleteness: feedbackItemSchema,
    structure: feedbackItemSchema,
    clarity: feedbackItemSchema,
    languageQuality: feedbackItemSchema,
    professionalism: feedbackItemSchema,
    attribution: feedbackItemSchema,
  })
  .strict();

export const reviewFindingSchema = z
  .object({
    category: reviewCategorySchema,
    severity: reviewSeveritySchema,
    issue: feedbackItemSchema,
    evidence: feedbackItemSchema,
    recommendation: feedbackItemSchema,
  })
  .strict();

export const readinessRisksSchema = z
  .object({
    severelyIncompleteOrUnreliable: z.boolean(),
    seriousFactualGaps: z.boolean(),
    unsupportedClaims: z.boolean(),
    majorStructuralProblems: z.boolean(),
    veryPoorLanguage: z.boolean(),
    seriousAttributionOrQuotationProblems: z.boolean(),
  })
  .strict();

const reviewCoreSchema = z
  .object({
    factualCompletenessScore: scoreSchema,
    structureScore: scoreSchema,
    clarityScore: scoreSchema,
    languageQualityScore: scoreSchema,
    professionalismScore: scoreSchema,
    attributionScore: scoreSchema,
    scoreReasons: scoreReasonsSchema,
    readinessRisks: readinessRisksSchema,
    findings: z.array(reviewFindingSchema).max(24),
    strengths: z.array(feedbackItemSchema).max(20),
    missingInformation: z.array(feedbackItemSchema).max(20),
    recommendations: z.array(feedbackItemSchema).max(20),
  })
  .strict();

export const reviewModelResponseSchema = reviewCoreSchema
  .extend({
    overallScore: scoreSchema,
    decision: z.enum(["PASS", "REWRITE_REQUIRED"]),
  })
  .strict();

export const reviewResultSchema = reviewCoreSchema
  .extend({
    overallScore: scoreSchema,
    weightedScore: scoreSchema,
    appliedScoreCap: scoreSchema.nullable(),
    scoreCapReasons: z.array(feedbackItemSchema).max(20),
    readinessBand: readinessBandSchema,
    decision: z.enum(["PASS", "REWRITE_REQUIRED"]),
  })
  .strict();

export const draftTextSchema = z.string().max(
  MAX_DRAFT_CHARS,
  "Drafts are limited to 50,000 characters.",
);

export const sourceUrlSchema = z
  .string()
  .trim()
  .max(MAX_SOURCE_URL_CHARS, "Source URLs are limited to 2,048 characters.")
  .refine((value) => !value || /^https?:\/\//iu.test(value), "Use a public http or https source URL.");

export const imageContextItemSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1).max(4_000),
    source: z.literal("link_caption"),
  })
  .strict();

export const editorialInputSchema = z
  .object({
    draft: draftTextSchema.default(""),
    sourceUrl: sourceUrlSchema.default(""),
  })
  .strict()
  .refine(
    ({ draft, sourceUrl }) => Boolean(draft.trim() || sourceUrl.trim()),
    "Enter draft text or a source URL before requesting a review.",
  );

export const sourceSnapshotSchema = z
  .object({
    primaryText: z.string().trim().min(1).max(MAX_REFERENCE_CHARS),
    userDraft: sourceTextSchema,
    sourceUrl: z.string().url().max(MAX_SOURCE_URL_CHARS).optional(),
    linkedTitle: z.string().trim().min(1).max(500).optional(),
    linkedText: sourceTextSchema.optional(),
    imageContext: z.array(imageContextItemSchema).max(MAX_IMAGE_CONTEXT_ITEMS),
  })
  .strict();

export const reviewRequestSchema = editorialInputSchema;
export const rewriteRequestSchema = z
  .object({
    source: sourceSnapshotSchema,
    review: reviewResultSchema,
  })
  .strict();

export const reviewApiResponseSchema = z
  .object({
    review: reviewResultSchema,
    source: sourceSnapshotSchema,
    passScore: z.number().min(0).max(100),
    message: z.string(),
  })
  .strict();

export const quotationIssueKindSchema = z.enum([
  "modified",
  "omitted",
  "split",
  "merged",
  "punctuation_changed",
]);

export const quotationIssueSchema = z
  .object({
    kind: quotationIssueKindSchema,
    original: z.string().min(1).max(8_100),
    rewrite: z.string().min(1).max(8_100).optional(),
    sourceParagraph: z.number().int().positive(),
    rewriteParagraph: z.number().int().positive().optional(),
    sourceExcerpt: z.string().min(1).max(1_000),
    differenceSummary: z.string().min(1).max(500),
    action: z.string().min(1).max(500),
  })
  .strict();

export const rewriteValidationSchema = z
  .object({
    status: z.enum(["passed", "passed_after_retry"]),
    attempts: z.union([z.literal(1), z.literal(2)]),
  })
  .strict();

export const rewriteApiResponseSchema = z
  .object({
    finalText: z.string().min(1),
    validation: rewriteValidationSchema,
  })
  .strict();

export const apiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.array(z.string()).optional(),
        retryable: z.boolean().optional(),
        stage: z.enum(["review_request", "rewrite_request"]).optional(),
        provider: z.string().trim().min(1).max(80).optional(),
        model: z.string().trim().min(1).max(120).optional(),
        httpStatus: z.number().int().min(0).max(599).optional(),
        causeSummary: z.string().trim().min(1).max(500).optional(),
        quotationIssues: z.array(quotationIssueSchema).optional(),
        candidateText: z.string().max(MAX_REFERENCE_CHARS).optional(),
        attempts: z.number().int().min(1).max(2).optional(),
      })
      .strict(),
  })
  .strict();

export type EditorialInput = z.infer<typeof editorialInputSchema>;
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export type ImageContextItem = z.infer<typeof imageContextItemSchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewModelResponse = z.infer<typeof reviewModelResponseSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type ReviewApiResponse = z.infer<typeof reviewApiResponseSchema>;
export type QuotationIssue = z.infer<typeof quotationIssueSchema>;
export type RewriteApiResponse = z.infer<typeof rewriteApiResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
