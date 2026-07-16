const MAX_QUOTATION_CHARS = 8_000;
const SHORT_LABEL_CHARS = 7;
const MAX_GROUP_MATCH = 4;

export type QuotationDelimiter =
  | "corner"
  | "double-corner"
  | "curly-double"
  | "curly-single"
  | "ascii-double"
  | "ascii-single";

export type QuotationClassification = "direct" | "label";

export type QuotationClassificationReason =
  | "attribution"
  | "sentence-length"
  | "short-label"
  | "uncertain-label";

export interface QuotationSpan {
  raw: string;
  content: string;
  canonicalContent: string;
  open: string;
  close: string;
  delimiter: QuotationDelimiter;
  start: number;
  end: number;
  paragraph: number;
  depth: number;
  classification: QuotationClassification;
  classificationReason: QuotationClassificationReason;
}

export type QuotationIssueKind =
  | "modified"
  | "omitted"
  | "split"
  | "merged"
  | "punctuation_changed";

export interface QuotationIssue {
  kind: QuotationIssueKind;
  source: QuotationSpan;
  sourceQuotes: QuotationSpan[];
  candidate?: QuotationSpan;
  candidateQuotes: QuotationSpan[];
  paragraph: number;
  candidateParagraph?: number;
  difference: string;
  action: string;
}

export interface QuotationValidationResult {
  valid: boolean;
  sourceDirectQuotations: QuotationSpan[];
  rewriteQuotations: QuotationSpan[];
  ignoredSourceLabels: QuotationSpan[];
  issues: QuotationIssue[];
}

interface ParagraphRange {
  start: number;
  end: number;
  paragraph: number;
}

interface OpeningFrame {
  open: string;
  close: string;
  delimiter: QuotationDelimiter;
  start: number;
  depth: number;
}

interface RawQuotationSpan {
  raw: string;
  content: string;
  open: string;
  close: string;
  delimiter: QuotationDelimiter;
  start: number;
  end: number;
  paragraph: number;
  paragraphStart: number;
  paragraphEnd: number;
  depth: number;
}

const asymmetricOpeners = new Map<string, Omit<OpeningFrame, "start" | "depth">>([
  ["「", { open: "「", close: "」", delimiter: "corner" }],
  ["『", { open: "『", close: "』", delimiter: "double-corner" }],
  ["“", { open: "“", close: "”", delimiter: "curly-double" }],
  ["‘", { open: "‘", close: "’", delimiter: "curly-single" }],
]);

const symmetricOpeners = new Map<string, Omit<OpeningFrame, "start" | "depth">>([
  ['"', { open: '"', close: '"', delimiter: "ascii-double" }],
  ["'", { open: "'", close: "'", delimiter: "ascii-single" }],
]);

const asymmetricClosers = new Set(["」", "』", "”", "’"]);
const wordCharacter = /[\p{L}\p{N}]/u;
const terminalPunctuation = /[。！？!?](?:[」』”’"'])*$/u;
const punctuationCharacter = /\p{P}/u;

const attributionBefore =
  /(?:\b(?:said|says|stated|added|asked|replied|wrote|told)\b|(?:說|問|回答|回應|寫道|表示|指出|強調|解釋|補充|透露|坦言|直言|稱))[^.!?。！？\r\n]{0,80}(?:[:：,，]\s*)?$/iu;
const strongShortAttributionBefore =
  /(?:\b(?:said|says|asked|replied|wrote)\b|(?:說|問|回答|回應|寫道|喊道|直言))[^.!?。！？\r\n]{0,24}(?:[:：,，]\s*)?$/iu;
const attributionAfter =
  /^\s*[,，]?\s*(?:(?:[\p{L}.'’-]+\s+){0,4}(?:said|says|stated|added|asked|replied|wrote)\b|[^。！？\r\n]{0,16}(?:說|表示|指出|強調|回應|解釋|補充|透露|坦言|稱))/iu;

function isEscaped(text: string, index: number) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function isBetweenWordCharacters(text: string, index: number) {
  const previous = text[index - 1] ?? "";
  const next = text[index + 1] ?? "";
  return wordCharacter.test(previous) && wordCharacter.test(next);
}

function canOpenAsciiQuotation(text: string, index: number, paragraphEnd: number) {
  const previous = text[index - 1] ?? "";
  if (previous && wordCharacter.test(previous)) return false;

  for (let cursor = index + 1; cursor < paragraphEnd; cursor += 1) {
    const character = text[cursor];
    if (!character || /\s/u.test(character)) continue;
    return character !== text[index];
  }
  return false;
}

function canCloseQuotation(text: string, index: number, delimiter: QuotationDelimiter) {
  if ((delimiter === "ascii-single" || delimiter === "curly-single") && isBetweenWordCharacters(text, index)) {
    return false;
  }
  if (delimiter === "ascii-double" || delimiter === "ascii-single") {
    const next = text[index + 1] ?? "";
    return !next || !wordCharacter.test(next);
  }
  return true;
}

function paragraphRanges(text: string): ParagraphRange[] {
  const ranges: ParagraphRange[] = [];
  const separator = /\r?\n[\t \f\v]*\r?\n(?:[\t \f\v]*\r?\n)*/gu;
  let start = 0;
  let paragraph = 1;

  for (const match of text.matchAll(separator)) {
    const end = match.index;
    if (text.slice(start, end).trim()) {
      ranges.push({ start, end, paragraph });
      paragraph += 1;
    }
    start = end + match[0].length;
  }

  if (text.slice(start).trim()) ranges.push({ start, end: text.length, paragraph });
  return ranges;
}

function parseQuotationSpans(text: string): RawQuotationSpan[] {
  const spans: RawQuotationSpan[] = [];

  for (const range of paragraphRanges(text)) {
    const stack: OpeningFrame[] = [];

    for (let index = range.start; index < range.end; index += 1) {
      const character = text[index];
      if (!character) continue;
      if ((character === '"' || character === "'") && isEscaped(text, index)) continue;

      const top = stack.at(-1);
      if (
        top &&
        character === top.close &&
        canCloseQuotation(text, index, top.delimiter)
      ) {
        stack.pop();
        const content = text.slice(top.start + top.open.length, index);
        if (content.trim() && content.length <= MAX_QUOTATION_CHARS) {
          spans.push({
            raw: text.slice(top.start, index + character.length),
            content,
            open: top.open,
            close: character,
            delimiter: top.delimiter,
            start: top.start,
            end: index + character.length,
            paragraph: range.paragraph,
            paragraphStart: range.start,
            paragraphEnd: range.end,
            depth: top.depth,
          });
        }
        continue;
      }

      const asymmetric = asymmetricOpeners.get(character);
      if (asymmetric) {
        stack.push({ ...asymmetric, start: index, depth: stack.length });
        continue;
      }

      const symmetric = symmetricOpeners.get(character);
      if (symmetric && canOpenAsciiQuotation(text, index, range.end)) {
        stack.push({ ...symmetric, start: index, depth: stack.length });
        continue;
      }

      // A mismatched or unpaired closer is ignored. Unclosed frames are discarded
      // at the paragraph boundary so one bad mark cannot consume later paragraphs.
      if (asymmetricClosers.has(character)) continue;
    }
  }

  return spans.sort((left, right) => left.start - right.start || right.end - left.end);
}

export function canonicalizeQuotationContent(content: string) {
  return Array.from(content.replace(/\r\n?/gu, "\n").normalize("NFC"))
    .map((character) =>
      punctuationCharacter.test(character) ? character.normalize("NFKC") : character,
    )
    .join("")
    .trim();
}

function classifyQuotation(text: string, span: RawQuotationSpan) {
  const canonical = canonicalizeQuotationContent(span.content);
  const length = Array.from(canonical).length;
  const hasTerminalPunctuation = terminalPunctuation.test(canonical);
  const before = text.slice(Math.max(span.paragraphStart, span.start - 100), span.start);
  const after = text.slice(span.end, Math.min(span.paragraphEnd, span.end + 100));
  const hasAttribution = attributionBefore.test(before) || attributionAfter.test(after);
  const hasImmediateAfterAttribution =
    /^\s*[,，]\s*/u.test(after) && attributionAfter.test(after);
  const hasStrongShortAttribution =
    strongShortAttributionBefore.test(before) || hasImmediateAfterAttribution;
  const hasAttributionColon = /[:：]\s*$/u.test(before) && attributionBefore.test(before);

  if (
    hasAttribution &&
    (length > SHORT_LABEL_CHARS || hasTerminalPunctuation || hasStrongShortAttribution || hasAttributionColon)
  ) {
    return {
      classification: "direct" as const,
      classificationReason: "attribution" as const,
    };
  }

  if ((hasTerminalPunctuation && length >= 6) || length >= 8) {
    return {
      classification: "direct" as const,
      classificationReason: "sentence-length" as const,
    };
  }

  if (length <= SHORT_LABEL_CHARS && !hasTerminalPunctuation) {
    return {
      classification: "label" as const,
      classificationReason: "short-label" as const,
    };
  }

  return {
    classification: "label" as const,
    classificationReason: "uncertain-label" as const,
  };
}

export function extractQuotationSpans(text: string): QuotationSpan[] {
  return parseQuotationSpans(text).map((span) => ({
    raw: span.raw,
    content: span.content,
    canonicalContent: canonicalizeQuotationContent(span.content),
    open: span.open,
    close: span.close,
    delimiter: span.delimiter,
    start: span.start,
    end: span.end,
    paragraph: span.paragraph,
    depth: span.depth,
    ...classifyQuotation(text, span),
  }));
}

function rootDirectQuotations(spans: QuotationSpan[]) {
  const direct = spans.filter((span) => span.classification === "direct");
  return direct.filter(
    (span) =>
      !direct.some(
        (possibleParent) =>
          possibleParent !== span &&
          possibleParent.start < span.start &&
          possibleParent.end > span.end,
      ),
  );
}

function concatenationMatches(parts: string[], expected: string) {
  return [parts.join(""), parts.join(" "), parts.join("\n")].includes(expected);
}

function punctuationOnlyDifference(source: string, candidate: string) {
  if (source === candidate) return false;
  const removePunctuation = (value: string) =>
    Array.from(value)
      .filter((character) => !punctuationCharacter.test(character))
      .join("");
  return removePunctuation(source) === removePunctuation(candidate);
}

function bigramSimilarity(left: string, right: string) {
  if (left === right) return 1;
  const leftCharacters = Array.from(left);
  const rightCharacters = Array.from(right);
  if (leftCharacters.length < 2 || rightCharacters.length < 2) {
    return leftCharacters[0] === rightCharacters[0] ? 1 : 0;
  }

  const leftBigrams = new Map<string, number>();
  for (let index = 0; index < leftCharacters.length - 1; index += 1) {
    const bigram = leftCharacters[index] + leftCharacters[index + 1];
    leftBigrams.set(bigram, (leftBigrams.get(bigram) ?? 0) + 1);
  }

  let intersection = 0;
  for (let index = 0; index < rightCharacters.length - 1; index += 1) {
    const bigram = rightCharacters[index] + rightCharacters[index + 1];
    const remaining = leftBigrams.get(bigram) ?? 0;
    if (remaining > 0) {
      intersection += 1;
      leftBigrams.set(bigram, remaining - 1);
    }
  }

  return (2 * intersection) / (leftCharacters.length + rightCharacters.length - 2);
}

function punctuationSummary(value: string) {
  return Array.from(value)
    .filter((character) => punctuationCharacter.test(character))
    .join("");
}

function preview(value: string, maximum = 24) {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  return characters.slice(0, maximum).join("") + "…";
}

function modifiedDifference(source: string, candidate: string) {
  const sourceCharacters = Array.from(source);
  const candidateCharacters = Array.from(candidate);
  let prefix = 0;
  while (
    prefix < sourceCharacters.length &&
    prefix < candidateCharacters.length &&
    sourceCharacters[prefix] === candidateCharacters[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < sourceCharacters.length - prefix &&
    suffix < candidateCharacters.length - prefix &&
    sourceCharacters[sourceCharacters.length - 1 - suffix] ===
      candidateCharacters[candidateCharacters.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const sourceChanged = sourceCharacters.slice(prefix, sourceCharacters.length - suffix).join("");
  const candidateChanged = candidateCharacters
    .slice(prefix, candidateCharacters.length - suffix)
    .join("");
  const count = Math.max(Array.from(sourceChanged).length, Array.from(candidateChanged).length);
  return `${count} character${count === 1 ? "" : "s"} differ beginning at character ${prefix + 1} (source: “${preview(sourceChanged)}”; rewrite: “${preview(candidateChanged)}”).`;
}

function issue(
  kind: QuotationIssueKind,
  sourceQuotes: QuotationSpan[],
  candidateQuotes: QuotationSpan[],
  difference: string,
  action: string,
): QuotationIssue {
  const source = sourceQuotes[0];
  const candidate = candidateQuotes[0];
  return {
    kind,
    source,
    sourceQuotes,
    candidate,
    candidateQuotes,
    paragraph: source.paragraph,
    candidateParagraph: candidate?.paragraph,
    difference,
    action,
  };
}

function findGroup<T>(
  values: T[],
  canonical: (value: T) => string,
  expected: string,
): T[] | undefined {
  for (let start = 0; start < values.length; start += 1) {
    for (
      let length = 2;
      length <= MAX_GROUP_MATCH && start + length <= values.length;
      length += 1
    ) {
      const group = values.slice(start, start + length);
      if (concatenationMatches(group.map(canonical), expected)) return group;
    }
  }
  return undefined;
}

export function validateQuotationPreservation(
  sourceText: string,
  rewriteText: string,
): QuotationValidationResult {
  const sourceSpans = extractQuotationSpans(sourceText);
  const sourceDirectQuotations = rootDirectQuotations(sourceSpans);
  const ignoredSourceLabels = sourceSpans.filter((span) => span.classification === "label");
  const rewriteQuotations = extractQuotationSpans(rewriteText);
  const matchedSources = new Set<number>();
  const usedCandidates = new Set<number>();
  const issues: QuotationIssue[] = [];

  // Exact canonical matches are allocated one-to-one. This deliberately preserves
  // duplicate quotations rather than allowing one rewrite occurrence to satisfy all.
  for (let sourceIndex = 0; sourceIndex < sourceDirectQuotations.length; sourceIndex += 1) {
    const source = sourceDirectQuotations[sourceIndex];
    const candidates = rewriteQuotations
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(
        ({ candidate, candidateIndex }) =>
          !usedCandidates.has(candidateIndex) &&
          candidate.canonicalContent === source.canonicalContent,
      )
      .sort(
        (left, right) =>
          Math.abs(left.candidate.paragraph - source.paragraph) -
            Math.abs(right.candidate.paragraph - source.paragraph) ||
          left.candidate.start - right.candidate.start,
      );

    const match = candidates[0];
    if (match) {
      matchedSources.add(sourceIndex);
      usedCandidates.add(match.candidateIndex);
    }
  }

  // A single source quotation may have been broken into multiple quote spans.
  for (let sourceIndex = 0; sourceIndex < sourceDirectQuotations.length; sourceIndex += 1) {
    if (matchedSources.has(sourceIndex)) continue;
    const source = sourceDirectQuotations[sourceIndex];
    const available = rewriteQuotations.filter((_, index) => !usedCandidates.has(index));
    const group = findGroup(available, (candidate) => candidate.canonicalContent, source.canonicalContent);
    if (!group) continue;

    matchedSources.add(sourceIndex);
    for (const candidate of group) usedCandidates.add(rewriteQuotations.indexOf(candidate));
    issues.push(
      issue(
        "split",
        [source],
        group,
        `The source quotation was split across ${group.length} rewrite quotations.`,
        "Restore the source quotation as one intact quotation near its attribution.",
      ),
    );
  }

  // Multiple source quotations may have been combined into one rewrite quote.
  for (let candidateIndex = 0; candidateIndex < rewriteQuotations.length; candidateIndex += 1) {
    if (usedCandidates.has(candidateIndex)) continue;
    const candidate = rewriteQuotations[candidateIndex];
    const availableSources = sourceDirectQuotations.filter(
      (_, sourceIndex) => !matchedSources.has(sourceIndex),
    );
    const group = findGroup(
      availableSources,
      (source) => source.canonicalContent,
      candidate.canonicalContent,
    );
    if (!group) continue;

    usedCandidates.add(candidateIndex);
    for (const source of group) matchedSources.add(sourceDirectQuotations.indexOf(source));
    issues.push(
      issue(
        "merged",
        group,
        [candidate],
        `${group.length} source quotations were merged into one rewrite quotation.`,
        "Restore each source quotation separately and exactly near its original attribution.",
      ),
    );
  }

  const remainingSourceCount = sourceDirectQuotations.filter(
    (_, sourceIndex) => !matchedSources.has(sourceIndex),
  ).length;
  const remainingCandidateCount = rewriteQuotations.filter(
    (_, candidateIndex) => !usedCandidates.has(candidateIndex),
  ).length;

  for (let sourceIndex = 0; sourceIndex < sourceDirectQuotations.length; sourceIndex += 1) {
    if (matchedSources.has(sourceIndex)) continue;
    const source = sourceDirectQuotations[sourceIndex];
    const candidates = rewriteQuotations
      .map((candidate, candidateIndex) => {
        const punctuationChanged = punctuationOnlyDifference(
          source.canonicalContent,
          candidate.canonicalContent,
        );
        const similarity = bigramSimilarity(source.canonicalContent, candidate.canonicalContent);
        const paragraphDistance = Math.abs(candidate.paragraph - source.paragraph);
        return {
          candidate,
          candidateIndex,
          punctuationChanged,
          similarity,
          paragraphDistance,
          score:
            similarity +
            (punctuationChanged ? 1 : 0) +
            (candidate.classification === "direct" ? 0.05 : 0) +
            0.08 / (paragraphDistance + 1),
        };
      })
      .filter(({ candidateIndex }) => !usedCandidates.has(candidateIndex))
      .sort((left, right) => right.score - left.score || left.candidate.start - right.candidate.start);

    const best = candidates[0];
    const isOnlyRemainingPair = remainingSourceCount === 1 && remainingCandidateCount === 1;
    const plausible =
      best &&
      (best.punctuationChanged ||
        best.similarity >= 0.34 ||
        (isOnlyRemainingPair && best.paragraphDistance <= 2));

    if (!best || !plausible) {
      matchedSources.add(sourceIndex);
      issues.push(
        issue(
          "omitted",
          [source],
          [],
          "No corresponding quotation was found in the rewrite.",
          "Reinsert the complete source quotation near its original attribution.",
        ),
      );
      continue;
    }

    matchedSources.add(sourceIndex);
    usedCandidates.add(best.candidateIndex);
    if (best.punctuationChanged) {
      issues.push(
        issue(
          "punctuation_changed",
          [source],
          [best.candidate],
          `Internal punctuation changed (source: “${punctuationSummary(source.canonicalContent)}”; rewrite: “${punctuationSummary(best.candidate.canonicalContent)}”).`,
          "Restore the source quotation's internal punctuation exactly; edit only outside the quotation marks.",
        ),
      );
    } else {
      issues.push(
        issue(
          "modified",
          [source],
          [best.candidate],
          modifiedDifference(source.canonicalContent, best.candidate.canonicalContent),
          "Restore the source quotation exactly; keep editorial changes outside the quotation marks.",
        ),
      );
    }
  }

  return {
    valid: issues.length === 0,
    sourceDirectQuotations,
    rewriteQuotations,
    ignoredSourceLabels,
    issues,
  };
}

export const validateDirectQuotationPreservation = validateQuotationPreservation;
