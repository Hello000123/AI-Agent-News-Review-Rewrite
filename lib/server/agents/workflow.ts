import { runReviewAgent, type CompletionRunner } from "@/lib/server/agents/review-agent";
import { runRewriteAgent } from "@/lib/server/agents/rewrite-agent";
import { getServerConfig } from "@/lib/server/config";
import type { ReviewResult } from "@/lib/shared/contracts";

interface WorkflowDependencies {
  completionRunner?: CompletionRunner;
  passScore?: number;
}

export async function reviewAndMaybeRewrite(draft: string, dependencies: WorkflowDependencies = {}) {
  const passScore = dependencies.passScore ?? getServerConfig().passScore;
  const review = await runReviewAgent(draft, passScore, dependencies.completionRunner);

  if (review.overallScore >= passScore) {
    return {
      review,
      finalText: draft,
      wasRewritten: false,
      passScore,
      message: "This draft received a strong quality score and does not require rewriting.",
    };
  }

  const finalText = await runRewriteAgent(draft, review, dependencies.completionRunner);
  return {
    review,
    finalText,
    wasRewritten: true,
    passScore,
    message: "This draft was below the quality threshold, so a rewritten version was created automatically.",
  };
}

export async function rewriteWithFeedback(
  draft: string,
  review: ReviewResult,
  completionRunner?: CompletionRunner,
) {
  return runRewriteAgent(draft, review, completionRunner);
}
