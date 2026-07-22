import { requestDeepSeekCompletion } from "@/lib/server/agents/deepseek-client";
import {
  createQuotationCorrectionPrompt,
  createRewriteValidationCorrectionPrompt,
  createRewriteUserPrompt,
  createUnchangedRewriteCorrectionPrompt,
  CONSERVATIVE_REWRITE_CORRECTION_SYSTEM_PROMPT,
  determineRequiredOutputLanguage,
  extractComparableNumericValues,
  extractVerbatimSourceScriptNames,
  FORMAT_CORRECTION_SYSTEM_PROMPT,
  extractVerbatimMixedLanguageTerms,
  preservesRequiredOutputLanguage,
  QUOTATION_CORRECTION_SYSTEM_PROMPT,
  REWRITE_SYSTEM_PROMPT,
  SOURCE_FIDELITY_CORRECTION_SYSTEM_PROMPT,
} from "@/lib/server/agents/prompts";
import {
  validateQuotationPreservation,
  type QuotationIssue as InternalQuotationIssue,
} from "@/lib/server/agents/quotation-validator";
import type { CompletionRunner } from "@/lib/server/agents/review-agent";
import { AppError } from "@/lib/server/errors";
import {
  MAX_REFERENCE_CHARS,
  quotationIssueSchema,
  rewriteApiResponseSchema,
  type QuotationIssue,
  type ReviewResult,
  type RewriteApiResponse,
  type RewriteContext,
  type SourceSnapshot,
} from "@/lib/shared/contracts";

const EMPTY_REWRITE_CONTEXT: RewriteContext = {
  history: [],
  refinement: { lengthOption: null, instruction: "" },
};

function removeCodeFence(text: string) {
  const match = text.match(/^\x60\x60\x60(?:text|markdown)?\s*([\s\S]*?)\s*\x60\x60\x60$/iu);
  return (match?.[1] ?? text).trim();
}

function sourceCorpus(source: SourceSnapshot, context: RewriteContext) {
  return [
    source.primaryText,
    source.linkedText ?? "",
    ...source.imageContext.map(({ text }) => text),
    ...context.history.map(({ instruction }) => instruction),
    context.refinement.instruction,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function canonicalArticle(text: string) {
  return text.normalize("NFC").replace(/[\p{P}\s]+/gu, "");
}

function isEditingBaselineEcho(
  candidate: string,
  source: SourceSnapshot,
  context: RewriteContext,
) {
  const candidateArticle = canonicalArticle(candidate);
  const currentRewrittenVersion = context.history.at(-1)?.rewrittenText;
  return [source.primaryText, currentRewrittenVersion]
    .filter((text): text is string => Boolean(text))
    .some((text) => candidateArticle === canonicalArticle(text));
}

function hasRequiredRewriteFormat(text: string) {
  return /^[^\r\n]+\r?\n\r?\n\S[\s\S]*$/u.test(text);
}

function restoreHeadlineAfterFocusedCorrection(candidate: string, firstCandidate: string) {
  if (hasRequiredRewriteFormat(candidate)) return candidate;

  const normalizedCandidate = candidate.replace(/\r\n?/gu, "\n").trim();
  const terminalPunctuationCount = (
    normalizedCandidate.match(/[.!?。！？](?=(?:[”’」』"']|\s|$))/gu) ?? []
  ).length;
  if (
    normalizedCandidate.includes("\n\n") ||
    normalizedCandidate.length < 80 ||
    terminalPunctuationCount < 2
  ) {
    return candidate;
  }

  const existingHeadline = hasRequiredRewriteFormat(firstCandidate)
    ? firstCandidate.split(/\r?\n/u, 1)[0]?.trim()
    : "";
  const firstSentence = normalizedCandidate.match(/^(.+?[.!?。！？])(?:\s|$)/u)?.[1]?.trim();
  const derivedHeadline = firstSentence?.replace(/[.!?。！？]+$/u, "").trim();
  const firstClause = derivedHeadline
    ?.split(/(?<!\d)[,，;；:：]|[,，;；:：](?!\d)/u, 1)[0]
    ?.trim();
  const factualHeadline = firstClause && Array.from(firstClause).length >= 20
    ? firstClause
    : derivedHeadline;
  const safeHeadline = existingHeadline || factualHeadline;
  const cappedHeadline = safeHeadline
    ? Array.from(safeHeadline).slice(0, 240).join("").trim()
    : "";
  return cappedHeadline ? `${cappedHeadline}\n\n${normalizedCandidate}` : candidate;
}

function paragraphAt(text: string, paragraphNumber: number) {
  const paragraphs = text
    .replace(/\r\n?/gu, "\n")
    .split(/\n[\t \f\v]*\n(?:[\t \f\v]*\n)*/gu)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return paragraphs[paragraphNumber - 1] ?? paragraphs.at(-1) ?? text.trim();
}

function publicQuotationIssues(
  issues: InternalQuotationIssue[],
  sourceText: string,
): QuotationIssue[] {
  return issues.flatMap((issue) =>
    issue.sourceQuotes.map((sourceQuote) =>
      quotationIssueSchema.parse({
        kind: issue.kind,
        original: sourceQuote.raw.slice(0, 8_100),
        rewrite:
          issue.candidateQuotes.length > 0
            ? issue.candidateQuotes
                .map(({ raw }) => raw)
                .join(" | ")
                .slice(0, 8_100)
            : undefined,
        sourceParagraph: sourceQuote.paragraph,
        rewriteParagraph: issue.candidateParagraph,
        sourceExcerpt: paragraphAt(sourceText, sourceQuote.paragraph).slice(0, 1_000),
        differenceSummary: issue.difference.slice(0, 500),
        action: issue.action.slice(0, 500),
      }),
    ),
  );
}

const englishSmallNumberValues: Readonly<Record<string, string>> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
};

function extractEnglishSmallNumberValues(text: string) {
  const words =
    text
      .toLocaleLowerCase("en")
      .match(
        /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/gu,
      ) ?? [];
  return words
    .map((word) => englishSmallNumberValues[word])
    .filter((value, index, values) => values.indexOf(value) === index);
}

function validateSafeCandidate(
  candidate: string,
  source: SourceSnapshot,
  context: RewriteContext,
) {
  if (!candidate) {
    throw new AppError(
      "EMPTY_REWRITE",
      "The Rewrite Agent returned an empty news report. Please try again.",
      502,
      { publicDetails: { retryable: true } },
    );
  }

  if (!hasRequiredRewriteFormat(candidate)) {
    throw new AppError(
      "INVALID_REWRITE_FORMAT",
      "The Rewrite Agent did not return a headline followed by a complete article. Please retry the rewrite.",
      502,
      { publicDetails: { retryable: true } },
    );
  }

  const missingMixedLanguageTerm = extractVerbatimMixedLanguageTerms(source.primaryText).find(
    (term) => !candidate.includes(term),
  );
  if (missingMixedLanguageTerm) {
    throw new AppError(
      "INEXACT_MIXED_LANGUAGE_TERM",
      `The Rewrite Agent omitted or changed the source term “${missingMixedLanguageTerm}”. Retry the rewrite so names and mixed-language terms remain exact.`,
      422,
      { publicDetails: { retryable: true } },
    );
  }

  if (!preservesRequiredOutputLanguage(source.primaryText, candidate)) {
    throw new AppError(
      "REWRITE_LANGUAGE_MISMATCH",
      `The Rewrite Agent did not preserve the source language (${determineRequiredOutputLanguage(source.primaryText)}). Please retry.`,
      422,
      { publicDetails: { retryable: true } },
    );
  }

  const missingSourceScriptNames = extractVerbatimSourceScriptNames(source.primaryText).filter(
    (name) => !candidate.includes(name),
  );
  if (missingSourceScriptNames.length > 0) {
    throw new AppError(
      "INEXACT_SOURCE_SCRIPT_NAME",
      `The Rewrite Agent omitted or romanized required source-script name${missingSourceScriptNames.length === 1 ? "" : "s"}: ${missingSourceScriptNames.map((name) => `“${name}”`).join(", ")}. Keep each listed name character-for-character at least once, even when the narration is English.`,
      422,
      { publicDetails: { retryable: true } },
    );
  }

  const allowedNumericValues = new Set(
    extractComparableNumericValues(sourceCorpus(source, context)),
  );
  const untraceableNumericValue = extractComparableNumericValues(candidate).find(
    (value) => !allowedNumericValues.has(value),
  );
  if (untraceableNumericValue) {
    throw new AppError(
      "UNTRACEABLE_REWRITE_NUMBER",
      `The Rewrite Agent introduced the number “${untraceableNumericValue}”, which is not in the submitted or retrieved source material. Please retry.`,
      422,
      { publicDetails: { retryable: true } },
    );
  }

  const requiredNumericValues = extractComparableNumericValues(source.primaryText);
  const outputNumericValues = new Set([
    ...extractComparableNumericValues(candidate),
    ...(determineRequiredOutputLanguage(source.primaryText) === "English"
      ? extractEnglishSmallNumberValues(candidate)
      : []),
  ]);
  const missingNumericValue = requiredNumericValues.find((value) => !outputNumericValues.has(value));
  if (missingNumericValue) {
    throw new AppError(
      "MISSING_REWRITE_NUMBER",
      `The Rewrite Agent omitted the source number “${missingNumericValue}”. Please retry so material figures and dates remain intact.`,
      422,
      { publicDetails: { retryable: true } },
    );
  }
}

function untraceableDirectQuotationError(
  validation: ReturnType<typeof validateQuotationPreservation>,
) {
  if (!validation.valid) return null;
  const allowedContents = new Set(
    [...validation.sourceDirectQuotations, ...validation.ignoredSourceLabels].map(
      ({ canonicalContent }) => canonicalContent,
    ),
  );
  const invented = validation.rewriteQuotations.find(
    ({ classification, classificationReason, canonicalContent }) =>
      classification === "direct" &&
      (classificationReason === "attribution" ||
        Array.from(canonicalContent).length >= 30) &&
      !allowedContents.has(canonicalContent),
  );
  if (!invented) return null;

  return new AppError(
    "UNTRACEABLE_REWRITE_QUOTATION",
    `The Rewrite Agent introduced direct quotation ${invented.raw}, which does not appear verbatim in the submitted or retrieved article. Retry so paraphrased material remains indirect speech.`,
    422,
    { publicDetails: { retryable: true } },
  );
}

interface NamedQuotationAttribution {
  speaker: string;
  quotation: InternalQuotationIssue["sourceQuotes"][number];
}

const englishPersonName = String.raw`[A-Z][\p{L}'’.-]+(?:\s+(?:[A-Z]\.\s*)?[A-Z][\p{L}'’.-]+){1,3}`;
const englishPersonTitle =
  String.raw`(?:(?:Dr|Prof|Professor|Director|Secretary|Chair|Chairman|Chairwoman|Councillor|Commissioner|Superintendent|Inspector|Principal|Coach|Judge|Mr|Mrs|Ms)\.?\s+)?`;
const englishAttributionVerb = String.raw`(?:said|says|stated|added|asked|replied|wrote|told)`;
const chineseAttributionVerb =
  String.raw`(?:說|問|回答|回應|寫道|表示|指出|強調|解釋|補充|透露|坦言|直言|稱)`;

function paragraphRangeAtOffset(text: string, offset: number) {
  const separator = /\r?\n[\t \f\v]*\r?\n(?:[\t \f\v]*\r?\n)*/gu;
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(separator)) {
    if (match.index >= offset) {
      end = match.index;
      break;
    }
    start = match.index + match[0].length;
  }
  return { start, end };
}

function extractEnglishNamedSpeaker(prefix: string, suffix: string) {
  const before = new RegExp(
    `${englishPersonTitle}(${englishPersonName})\\s+${englishAttributionVerb}[^.!?\\r\\n]{0,24}(?:[:：,，]\\s*)?$`,
    "u",
  ).exec(prefix.slice(-180));
  if (before?.[1]) return before[1];

  const after = new RegExp(
    `^\\s*[,，]?\\s*${englishPersonTitle}(${englishPersonName})\\s+${englishAttributionVerb}\\b`,
    "u",
  ).exec(suffix.slice(0, 180));
  return after?.[1] ?? null;
}

function extractChineseNamedSpeaker(prefix: string, suffix: string) {
  const precedingText = prefix.slice(-180);
  const precedingNames = extractVerbatimSourceScriptNames(precedingText);
  for (const name of [...precedingNames].reverse()) {
    const pattern = new RegExp(
      `${name}[^。！？\\r\\n]{0,48}${chineseAttributionVerb}[^。！？\\r\\n]{0,24}(?:[:：,，]\\s*)?$`,
      "u",
    );
    if (pattern.test(precedingText)) return name;
  }

  const followingText = suffix.slice(0, 180);
  const followingNames = extractVerbatimSourceScriptNames(followingText);
  for (const name of followingNames) {
    const pattern = new RegExp(
      `^\\s*[,，]?\\s*[^。！？\\r\\n]{0,16}${name}[^。！？\\r\\n]{0,24}${chineseAttributionVerb}`,
      "u",
    );
    if (pattern.test(followingText)) return name;
  }
  return null;
}

function namedSpeakerForQuotation(
  text: string,
  quotation: InternalQuotationIssue["sourceQuotes"][number],
) {
  const range = paragraphRangeAtOffset(text, quotation.start);
  const prefix = text.slice(range.start, quotation.start);
  const suffix = text.slice(quotation.end, range.end);
  return (
    extractEnglishNamedSpeaker(prefix, suffix) ??
    extractChineseNamedSpeaker(prefix, suffix)
  );
}

function hasClearEnglishSurnameAttribution(
  text: string,
  quotation: InternalQuotationIssue["sourceQuotes"][number],
  requiredSpeaker: string,
) {
  const nameParts = requiredSpeaker.trim().split(/\s+/u);
  const surname = nameParts.at(-1);
  if (nameParts.length < 2 || !surname || !/^[\p{Script=Latin}'’.-]+$/u.test(surname)) {
    return false;
  }

  const range = paragraphRangeAtOffset(text, quotation.start);
  const paragraph = text.slice(range.start, range.end);
  if (!paragraph.includes(requiredSpeaker)) return false;

  const escapedSurname = surname.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const prefix = text.slice(range.start, quotation.start).slice(-100);
  const suffix = text.slice(quotation.end, range.end).slice(0, 100);
  const before = new RegExp(
    `\\b${escapedSurname}\\s+${englishAttributionVerb}[^.!?\\r\\n]{0,24}(?:[:：,，]\\s*)?$`,
    "u",
  );
  const after = new RegExp(
    `^\\s*[,，]?\\s*${escapedSurname}\\s+${englishAttributionVerb}\\b`,
    "u",
  );
  return before.test(prefix) || after.test(suffix);
}

function namedQuotationAttributionError(
  sourceText: string,
  candidateText: string,
  validation: ReturnType<typeof validateQuotationPreservation>,
  attempts: number,
) {
  if (!validation.valid) return null;

  const protectedAttributions = validation.sourceDirectQuotations.flatMap(
    (quotation): NamedQuotationAttribution[] => {
      const speaker = namedSpeakerForQuotation(sourceText, quotation);
      return speaker ? [{ speaker, quotation }] : [];
    },
  );
  if (protectedAttributions.length === 0) return null;

  const usedCandidateIndexes = new Set<number>();
  for (const { speaker, quotation: sourceQuotation } of protectedAttributions) {
    const exactCandidates = validation.rewriteQuotations
      .map((quotation, index) => ({ quotation, index }))
      .filter(
        ({ quotation, index }) =>
          !usedCandidateIndexes.has(index) &&
          quotation.canonicalContent === sourceQuotation.canonicalContent,
      );
    const correctlyAttributed = exactCandidates.find(
      ({ quotation }) =>
        namedSpeakerForQuotation(candidateText, quotation) === speaker ||
        hasClearEnglishSurnameAttribution(candidateText, quotation, speaker),
    );
    if (correctlyAttributed) {
      usedCandidateIndexes.add(correctlyAttributed.index);
      continue;
    }

    const corresponding = exactCandidates[0];
    const returnedSpeaker = corresponding
      ? namedSpeakerForQuotation(candidateText, corresponding.quotation)
      : null;
    const rewriteLocation = corresponding
      ? ` rewrite paragraph ${corresponding.quotation.paragraph}`
      : " the rewritten article";
    return new AppError(
      "REWRITE_ATTRIBUTION_MISMATCH",
      `Quotation attribution failed for ${sourceQuotation.raw} in source paragraph ${sourceQuotation.paragraph}: it must remain explicitly attributed to ${speaker} in the same paragraph. Retry the rewrite.`,
      422,
      {
        publicDetails: {
          retryable: true,
          attempts,
          candidateText: candidateText.slice(0, MAX_REFERENCE_CHARS),
          details: [
            `Original quotation: ${sourceQuotation.raw}`,
            `Required named speaker: ${speaker}`,
            `Location: source paragraph ${sourceQuotation.paragraph};${rewriteLocation}.`,
            returnedSpeaker
              ? `Problem: the rewrite attributed the quotation to ${returnedSpeaker} instead.`
              : "Problem: the rewrite omitted a close, explicit named-speaker attribution.",
            `Action: keep ${speaker} explicitly credited beside this quotation, then retry the rewrite.`,
          ],
        },
      },
    );
  }
  return null;
}

function repairPunctuationOnlyQuotations(
  candidate: string,
  validation: ReturnType<typeof validateQuotationPreservation>,
) {
  if (
    validation.issues.length === 0 ||
    validation.issues.some(
      (issue) =>
        issue.kind !== "punctuation_changed" ||
        issue.sourceQuotes.length !== 1 ||
        issue.candidateQuotes.length !== 1,
    )
  ) {
    return null;
  }

  const edits = validation.issues
    .map((issue) => ({
      start: issue.candidateQuotes[0].start,
      end: issue.candidateQuotes[0].end,
      replacement: issue.sourceQuotes[0].raw,
    }))
    .sort((left, right) => right.start - left.start);
  if (edits.some((edit, index) => index > 0 && edit.end > edits[index - 1].start)) {
    return null;
  }

  return edits.reduce(
    (text, edit) => text.slice(0, edit.start) + edit.replacement + text.slice(edit.end),
    candidate,
  );
}

function unchangedError(candidateText: string, attempts: number) {
  return new AppError(
    "UNCHANGED_REWRITE",
    "The Rewrite Agent returned an exact, whitespace-only, or punctuation-only copy of the active editing baseline after the correction attempt. Retry the rewrite; no older result has been substituted.",
    422,
    {
      publicDetails: {
        retryable: true,
        candidateText: candidateText.slice(0, MAX_REFERENCE_CHARS),
        attempts,
      },
    },
  );
}

function quotationError(
  issues: QuotationIssue[],
  candidateText: string,
  attempts: number,
) {
  return new AppError(
    "INEXACT_REWRITE_QUOTATION",
    "Quotation preservation still failed after one automatic correction attempt. Review the exact differences below, then retry the rewrite.",
    422,
    {
      publicDetails: {
        retryable: true,
        quotationIssues: issues,
        candidateText: candidateText.slice(0, MAX_REFERENCE_CHARS),
        attempts,
      },
    },
  );
}

async function generateCandidate(
  userPrompt: string,
  completionRunner: CompletionRunner,
  systemPrompt = REWRITE_SYSTEM_PROMPT,
  temperature = 0.1,
) {
  const content = await completionRunner({
    stage: "rewrite_request",
    systemPrompt,
    userPrompt,
    responseFormat: "text",
    maxTokens: 64_000,
    temperature,
  });
  return removeCodeFence(content);
}

export async function runRewriteAgent(
  source: SourceSnapshot,
  review: ReviewResult,
  completionRunner: CompletionRunner = requestDeepSeekCompletion,
  context: RewriteContext = EMPTY_REWRITE_CONTEXT,
): Promise<RewriteApiResponse> {
  const firstCandidate = await generateCandidate(
    createRewriteUserPrompt(source, review, context),
    completionRunner,
  );

  let firstSafetyError: AppError | null = null;
  try {
    validateSafeCandidate(firstCandidate, source, context);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    firstSafetyError = error;
  }

  const firstQuotationValidation = validateQuotationPreservation(
    source.primaryText,
    firstCandidate,
  );
  if (!firstSafetyError) {
    firstSafetyError = untraceableDirectQuotationError(firstQuotationValidation);
  }
  if (!firstSafetyError) {
    firstSafetyError = namedQuotationAttributionError(
      source.primaryText,
      firstCandidate,
      firstQuotationValidation,
      1,
    );
  }
  const firstIssues = publicQuotationIssues(
    firstQuotationValidation.issues,
    source.primaryText,
  );
  const firstIsUnchanged = isEditingBaselineEcho(firstCandidate, source, context);

  if (!firstSafetyError && firstQuotationValidation.valid && !firstIsUnchanged) {
    return rewriteApiResponseSchema.parse({
      finalText: firstCandidate,
      validation: { status: "passed", attempts: 1 },
    });
  }

  const correctionPrompt = firstSafetyError
    ? createRewriteValidationCorrectionPrompt(
        firstCandidate,
        { code: firstSafetyError.code, message: firstSafetyError.message },
        source,
        review,
        context,
      )
    : firstIsUnchanged
      ? createUnchangedRewriteCorrectionPrompt(
          firstCandidate,
          source,
          review,
          context,
        )
      : createQuotationCorrectionPrompt(
          firstCandidate,
          firstIssues,
          source,
        );

  let secondCandidate = "";
  try {
    const isQuotationCorrection = !firstSafetyError && !firstIsUnchanged;
    const isSourceFidelityCorrection =
      firstSafetyError?.code === "INEXACT_SOURCE_SCRIPT_NAME" ||
      firstSafetyError?.code === "REWRITE_ATTRIBUTION_MISMATCH";
    const isFormatCorrection =
      firstSafetyError?.code === "INVALID_REWRITE_FORMAT" ||
      firstSafetyError?.code === "EMPTY_REWRITE";
    const isUnchangedCorrection = !firstSafetyError && firstIsUnchanged;
    secondCandidate = await generateCandidate(
      correctionPrompt,
      completionRunner,
      isQuotationCorrection
        ? QUOTATION_CORRECTION_SYSTEM_PROMPT
        : isSourceFidelityCorrection
          ? SOURCE_FIDELITY_CORRECTION_SYSTEM_PROMPT
          : isFormatCorrection
            ? FORMAT_CORRECTION_SYSTEM_PROMPT
            : isUnchangedCorrection
              ? CONSERVATIVE_REWRITE_CORRECTION_SYSTEM_PROMPT
          : REWRITE_SYSTEM_PROMPT,
      isQuotationCorrection ||
      isSourceFidelityCorrection ||
      isFormatCorrection ||
      isUnchangedCorrection
        ? 0
        : 0.1,
    );
    secondCandidate = restoreHeadlineAfterFocusedCorrection(secondCandidate, firstCandidate);
    validateSafeCandidate(secondCandidate, source, context);
  } catch (error) {
    // A quotation-failed first draft is safe to retain for diagnosis when the
    // focused correction itself is unusable. Never fall back to an older UI result.
    if (!firstSafetyError && !firstIsUnchanged && firstIssues.length > 0) {
      throw quotationError(firstIssues, firstCandidate, 2);
    }
    if (error instanceof AppError && secondCandidate) {
      throw new AppError(error.code, error.publicMessage, error.status, {
        cause: error,
        publicDetails: {
          ...error.publicDetails,
          retryable: error.publicDetails?.retryable ?? true,
          candidateText: secondCandidate.slice(0, MAX_REFERENCE_CHARS),
          attempts: 2,
        },
      });
    }
    throw error;
  }

  if (isEditingBaselineEcho(secondCandidate, source, context)) {
    throw unchangedError(secondCandidate, 2);
  }

  const secondQuotationValidation = validateQuotationPreservation(
    source.primaryText,
    secondCandidate,
  );
  if (!secondQuotationValidation.valid) {
    const punctuationRepairedCandidate = repairPunctuationOnlyQuotations(
      secondCandidate,
      secondQuotationValidation,
    );
    if (punctuationRepairedCandidate) {
      validateSafeCandidate(punctuationRepairedCandidate, source, context);
      if (isEditingBaselineEcho(punctuationRepairedCandidate, source, context)) {
        throw unchangedError(punctuationRepairedCandidate, 2);
      }
      const repairedValidation = validateQuotationPreservation(
        source.primaryText,
        punctuationRepairedCandidate,
      );
      const untraceableRepairedQuotation = untraceableDirectQuotationError(
        repairedValidation,
      );
      const repairedAttributionError = namedQuotationAttributionError(
        source.primaryText,
        punctuationRepairedCandidate,
        repairedValidation,
        2,
      );
      if (
        repairedValidation.valid &&
        !untraceableRepairedQuotation &&
        !repairedAttributionError
      ) {
        return rewriteApiResponseSchema.parse({
          finalText: punctuationRepairedCandidate,
          validation: { status: "passed_after_retry", attempts: 2 },
        });
      }
      if (untraceableRepairedQuotation) throw untraceableRepairedQuotation;
      if (repairedAttributionError) throw repairedAttributionError;
    }
    throw quotationError(
      publicQuotationIssues(secondQuotationValidation.issues, source.primaryText),
      secondCandidate,
      2,
    );
  }
  const untraceableSecondQuotation = untraceableDirectQuotationError(
    secondQuotationValidation,
  );
  if (untraceableSecondQuotation) throw untraceableSecondQuotation;
  const secondAttributionError = namedQuotationAttributionError(
    source.primaryText,
    secondCandidate,
    secondQuotationValidation,
    2,
  );
  if (secondAttributionError) throw secondAttributionError;

  return rewriteApiResponseSchema.parse({
    finalText: secondCandidate,
    validation: { status: "passed_after_retry", attempts: 2 },
  });
}
