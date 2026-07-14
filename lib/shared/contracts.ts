import { z } from "zod";

export const MAX_DRAFT_CHARS = 50_000;
export const MAX_REQUEST_BYTES = 220_000;

// Content combines factual consistency (25%) and completeness of the core
// announcement (15%) so the public API can stay backward compatible.
export const REVIEW_SCORE_WEIGHTS = {
  contentScore: 0.4,
  clarityScore: 0.2,
  structureScore: 0.2,
  toneScore: 0.15,
  writingScore: 0.05,
} as const;

export type ReviewCategoryScores = Record<keyof typeof REVIEW_SCORE_WEIGHTS, number>;

export function calculateOverallScore(scores: ReviewCategoryScores) {
  return Math.round(
    scores.contentScore * REVIEW_SCORE_WEIGHTS.contentScore +
      scores.clarityScore * REVIEW_SCORE_WEIGHTS.clarityScore +
      scores.structureScore * REVIEW_SCORE_WEIGHTS.structureScore +
      scores.toneScore * REVIEW_SCORE_WEIGHTS.toneScore +
      scores.writingScore * REVIEW_SCORE_WEIGHTS.writingScore,
  );
}

const scoreSchema = z.number().finite().min(0).max(100);
const feedbackItemSchema = z.string().trim().min(1).max(600);
const scoreReasonsSchema = z
  .object({
    content: feedbackItemSchema,
    clarity: feedbackItemSchema,
    structure: feedbackItemSchema,
    tone: feedbackItemSchema,
    writing: feedbackItemSchema,
  })
  .strict();

export const reviewResultSchema = z
  .object({
    overallScore: scoreSchema,
    contentScore: scoreSchema,
    writingScore: scoreSchema,
    structureScore: scoreSchema,
    toneScore: scoreSchema,
    clarityScore: scoreSchema,
    scoreReasons: scoreReasonsSchema,
    decision: z.enum(["PASS", "REWRITE_REQUIRED"]),
    strengths: z.array(feedbackItemSchema).max(20),
    problems: z.array(feedbackItemSchema).max(20),
    missingInformation: z.array(feedbackItemSchema).max(20),
    recommendations: z.array(feedbackItemSchema).max(20),
  })
  .strict();

export const draftSchema = z
  .string()
  .max(MAX_DRAFT_CHARS, "Drafts are limited to 50,000 characters.")
  .refine((value) => value.trim().length > 0, "Enter a draft before requesting a review.");

export const reviewRequestSchema = z.object({ draft: draftSchema }).strict();
export const rewriteRequestSchema = z
  .object({
    draft: draftSchema,
    review: reviewResultSchema,
  })
  .strict();

export const reviewApiResponseSchema = z
  .object({
    review: reviewResultSchema,
    passScore: z.number().min(0).max(100),
    message: z.string(),
  })
  .strict();

export const rewriteApiResponseSchema = z.object({ finalText: z.string().min(1) }).strict();

export const apiErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.array(z.string()).optional(),
    }),
  })
  .strict();

export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type ReviewApiResponse = z.infer<typeof reviewApiResponseSchema>;
export type RewriteApiResponse = z.infer<typeof rewriteApiResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
