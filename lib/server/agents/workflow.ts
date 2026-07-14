import { runReviewAgent, type CompletionRunner } from "@/lib/server/agents/review-agent";
import { runRewriteAgent } from "@/lib/server/agents/rewrite-agent";
import { getServerConfig } from "@/lib/server/config";
import type { ReviewResult } from "@/lib/shared/contracts";

interface ReviewWorkflowDependencies {
  completionRunner?: CompletionRunner;
  passScore?: number;
}

export async function reviewDraft(
  draft: string,
  dependencies: ReviewWorkflowDependencies = {},
) {
  const passScore = dependencies.passScore ?? getServerConfig().passScore;
  const review = await runReviewAgent(draft, passScore, dependencies.completionRunner);

  return {
    review,
    passScore,
    message:
      review.overallScore >= passScore
        ? "This draft meets the quality threshold. Review the feedback, then choose how to continue."
        : "This draft is below the quality threshold. Review the feedback, then choose how to continue.",
  };
}

export async function rewriteWithFeedback(
  draft: string,
  review: ReviewResult,
  completionRunner?: CompletionRunner,
) {
  return runRewriteAgent(draft, review, completionRunner);
}
