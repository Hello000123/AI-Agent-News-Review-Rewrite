export interface TimeContextAnalysis {
  readonly exactDateExpressions: string[];
  readonly relativeTimeExpressions: string[];
  readonly uncertaintyCues: string[];
  readonly contradictionCues: string[];
}

const ENGLISH_MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const ENGLISH_DAY = "(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?";
const FOUR_DIGIT_YEAR = "(?:1[6-9]\\d{2}|20\\d{2}|21\\d{2})";

const exactDatePatterns = [
  new RegExp(`\\b${ENGLISH_DAY}\\s+${ENGLISH_MONTH}\\s+${FOUR_DIGIT_YEAR}\\b`, "giu"),
  new RegExp(
    `\\b${ENGLISH_MONTH}\\s+${ENGLISH_DAY}(?:\\s*,\\s*|\\s+)${FOUR_DIGIT_YEAR}\\b`,
    "giu",
  ),
  /(?<!\d)(?:1[6-9]\d{2}|20\d{2}|21\d{2})\s*年\s*(?:0?[1-9]|1[0-2])\s*月\s*(?:0?[1-9]|[12]\d|3[01])\s*[日號](?!\d)/gu,
  /(?<!\d)(?:1[6-9]\d{2}|20\d{2}|21\d{2})[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])(?!\d)/gu,
] as const;

const relativeTimePatterns = [
  /\b(?:earlier\s+this\s+week|this\s+morning|last\s+week|yesterday|today|recently|on\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))\b/giu,
  /(?:本週較早時|上星期(?:[一二三四五六日天])?|星期[一二三四五六日天]|昨天|今日|近日|近期|今早)/gu,
] as const;

const uncertaintyPatterns = [
  /\b(?:not\s+(?:yet\s+)?confirmed|to\s+be\s+confirmed|unconfirmed|uncertain|unclear|unknown|perhaps|possibly|maybe)\b/giu,
  /(?:尚未確定|仍未確定|未能確認|未獲確認|有待確認|日期未定|時間未定|不確定|不清楚|未確定|未明|或許|可能)/gu,
] as const;

const contradictionPatterns = [
  /\b(?:contradict(?:s|ed|ory|ion)?|conflict(?:s|ed|ing)?|inconsistent|does\s+not\s+match|do\s+not\s+match|at\s+odds)\b/giu,
  /(?:互相矛盾|前後矛盾|前後不一|互相衝突|相抵觸|不一致|矛盾)/gu,
] as const;

function compactMatch(value: string) {
  return value.trim().replace(/\s+/gu, " ");
}

function comparisonKey(value: string) {
  return compactMatch(value).normalize("NFKC").toLocaleLowerCase("en");
}

function collectUniqueMatches(text: string, patterns: readonly RegExp[]) {
  const matches: Array<{ index: number; value: string }> = [];

  for (const pattern of patterns) {
    const expression = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(expression)) {
      if (match.index === undefined || !match[0]) continue;
      matches.push({ index: match.index, value: compactMatch(match[0]) });
    }
  }

  matches.sort((left, right) => left.index - right.index || right.value.length - left.value.length);

  const seen = new Set<string>();
  return matches.flatMap(({ value }) => {
    const key = comparisonKey(value);
    if (seen.has(key)) return [];
    seen.add(key);
    return [value];
  });
}

/**
 * Reports lexical date/time signals found in submitted copy. This is deliberately
 * presence-only: it does not decide whether time context is relevant, sufficient,
 * clear, accurate, or contradictory.
 */
export function analyzeTimeContext(text: string): TimeContextAnalysis {
  return {
    exactDateExpressions: collectUniqueMatches(text, exactDatePatterns),
    relativeTimeExpressions: collectUniqueMatches(text, relativeTimePatterns),
    uncertaintyCues: collectUniqueMatches(text, uncertaintyPatterns),
    contradictionCues: collectUniqueMatches(text, contradictionPatterns),
  };
}
