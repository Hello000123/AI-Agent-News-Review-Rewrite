import {
  requestDeepSeekCompletion,
  type CompletionRequest,
} from "@/lib/server/agents/deepseek-client";
import {
  createReviewSystemPrompt,
  createReviewUserPrompt,
} from "@/lib/server/agents/prompts";
import { AppError } from "@/lib/server/errors";
import {
  calculateOverallScore,
  reviewResultSchema,
  type ReviewResult,
} from "@/lib/shared/contracts";

export type CompletionRunner = (request: CompletionRequest) => Promise<string>;

export function parseReviewResponse(content: string, passScore: number): ReviewResult {
  let rawReview: unknown;
  try {
    rawReview = JSON.parse(content);
  } catch (error) {
    throw new AppError(
      "MALFORMED_REVIEW_JSON",
      "The Review Agent returned invalid JSON. Please try the review again.",
      502,
      { cause: error },
    );
  }

  const parsed = reviewResultSchema.safeParse(rawReview);
  if (!parsed.success) {
    throw new AppError(
      "INVALID_REVIEW_FORMAT",
      "The Review Agent returned an incomplete assessment. Please try the review again.",
      502,
    );
  }

  // Category scores are the source of truth. Recomputing the weighted overall
  // removes model arithmetic drift and keeps the displayed score and decision aligned.
  const overallScore = calculateOverallScore(parsed.data);
  return {
    ...parsed.data,
    overallScore,
    decision: overallScore >= passScore ? "PASS" : "REWRITE_REQUIRED",
  };
}

export async function runReviewAgent(
  draft: string,
  passScore: number,
  completionRunner: CompletionRunner = requestDeepSeekCompletion,
) {
  const content = await completionRunner({
    systemPrompt: createReviewSystemPrompt(passScore),
    userPrompt: createReviewUserPrompt(draft),
    responseFormat: "json",
    maxTokens: 2_400,
    // Reviews should be as repeatable as the provider allows; rewriting remains
    // separately configured for natural prose generation.
    temperature: 0,
  });

  return parseReviewResponse(content, passScore);
}
