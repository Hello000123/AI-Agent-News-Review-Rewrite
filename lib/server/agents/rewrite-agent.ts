import { requestDeepSeekCompletion } from "@/lib/server/agents/deepseek-client";
import { createRewriteUserPrompt, REWRITE_SYSTEM_PROMPT } from "@/lib/server/agents/prompts";
import type { CompletionRunner } from "@/lib/server/agents/review-agent";
import { AppError } from "@/lib/server/errors";
import type { ReviewResult } from "@/lib/shared/contracts";

function removeCodeFence(text: string) {
  const match = text.match(/^\x60\x60\x60(?:text|markdown)?\s*([\s\S]*?)\s*\x60\x60\x60$/i);
  return (match?.[1] ?? text).trim();
}

export async function runRewriteAgent(
  draft: string,
  review: ReviewResult,
  completionRunner: CompletionRunner = requestDeepSeekCompletion,
) {
  const content = await completionRunner({
    systemPrompt: REWRITE_SYSTEM_PROMPT,
    userPrompt: createRewriteUserPrompt(draft, review),
    responseFormat: "text",
    maxTokens: 16_000,
    temperature: 0.3,
  });
  const finalText = removeCodeFence(content);

  if (!finalText) {
    throw new AppError(
      "EMPTY_REWRITE",
      "The Rewrite Agent returned an empty press release. Please try again.",
      502,
    );
  }

  return finalText;
}
