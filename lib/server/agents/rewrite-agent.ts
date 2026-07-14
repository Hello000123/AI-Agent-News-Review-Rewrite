import { requestDeepSeekCompletion } from "@/lib/server/agents/deepseek-client";
import {
  createRewriteUserPrompt,
  determineRequiredOutputLanguage,
  extractNumericValues,
  extractVerbatimDirectQuotations,
  extractVerbatimMixedLanguageTerms,
  preservesRequiredOutputLanguage,
  REWRITE_SYSTEM_PROMPT,
} from "@/lib/server/agents/prompts";
import type { CompletionRunner } from "@/lib/server/agents/review-agent";
import { AppError } from "@/lib/server/errors";
import type { ReviewResult } from "@/lib/shared/contracts";

function removeCodeFence(text: string) {
  const match = text.match(/^\x60\x60\x60(?:text|markdown)?\s*([\s\S]*?)\s*\x60\x60\x60$/i);
  return (match?.[1] ?? text).trim();
}

function countOccurrences(text: string, value: string) {
  let count = 0;
  let position = 0;
  while ((position = text.indexOf(value, position)) !== -1) {
    count += 1;
    position += value.length;
  }
  return count;
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
    temperature: 0.1,
  });
  const finalText = removeCodeFence(content);

  if (!finalText) {
    throw new AppError(
      "EMPTY_REWRITE",
      "The Rewrite Agent returned an empty news report. Please try again.",
      502,
    );
  }

  if (!/^[^\r\n]+\r?\n\r?\n\S[\s\S]*$/u.test(finalText)) {
    throw new AppError(
      "INVALID_REWRITE_FORMAT",
      "The Rewrite Agent returned an incorrectly formatted news report. Please try again.",
      502,
    );
  }

  const sourceQuotations = extractVerbatimDirectQuotations(draft);
  const missingQuotation = sourceQuotations.find(
    (quotation) =>
      countOccurrences(finalText, quotation) < countOccurrences(draft, quotation),
  );
  if (missingQuotation) {
    throw new AppError(
      "INEXACT_REWRITE_QUOTATION",
      "The Rewrite Agent did not preserve every direct quotation exactly. Please try again.",
      502,
    );
  }

  const missingMixedLanguageTerm = extractVerbatimMixedLanguageTerms(draft).find(
    (term) => !finalText.includes(term),
  );
  if (missingMixedLanguageTerm) {
    throw new AppError(
      "INEXACT_MIXED_LANGUAGE_TERM",
      "The Rewrite Agent did not preserve every mixed-language name or term exactly. Please try again.",
      502,
    );
  }

  if (!preservesRequiredOutputLanguage(draft, finalText)) {
    throw new AppError(
      "REWRITE_LANGUAGE_MISMATCH",
      `The Rewrite Agent did not preserve the draft's required output language (${determineRequiredOutputLanguage(draft)}). Please try again.`,
      502,
    );
  }

  const allowedNumericValues = new Set(extractNumericValues(draft));
  const untraceableNumericValue = extractNumericValues(finalText).find(
    (value) => !allowedNumericValues.has(value),
  );
  if (untraceableNumericValue) {
    throw new AppError(
      "UNTRACEABLE_REWRITE_NUMBER",
      "The Rewrite Agent introduced a number or statistic that could not be traced exactly to the draft. Please try again.",
      502,
    );
  }

  return finalText;
}
