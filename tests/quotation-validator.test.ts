import { describe, expect, it } from "vitest";

import {
  canonicalizeQuotationContent,
  extractQuotationSpans,
  validateQuotationPreservation,
} from "@/lib/server/agents/quotation-validator";

describe("quotation span extraction", () => {
  it("parses Chinese, curly, and sensible ASCII quotation pairs", () => {
    const text = [
      "甲說：「第一句。」乙回答：『第二句。』",
      "A said, “Third.” B replied, ‘It’s fourth.’",
      `C said "Fifth." D said 'Sixth.' Do not treat don't or 6" as quotations.`,
    ].join("\n");

    const spans = extractQuotationSpans(text);

    expect(spans.map(({ raw }) => raw)).toEqual([
      "「第一句。」",
      "『第二句。』",
      "“Third.”",
      "‘It’s fourth.’",
      '"Fifth."',
      "'Sixth.'",
    ]);
    expect(spans.every(({ classification }) => classification === "direct")).toBe(true);
    expect(spans.every(({ start, end, raw }) => text.slice(start, end) === raw)).toBe(true);
  });

  it("distinguishes short quoted labels from attributed speech", () => {
    const text = "今屆有24名「狀元」，其中11名「超級狀元」。黃同學說：「好。」";
    const spans = extractQuotationSpans(text);

    expect(spans.map(({ raw, classification, classificationReason }) => ({
      raw,
      classification,
      classificationReason,
    }))).toEqual([
      { raw: "「狀元」", classification: "label", classificationReason: "short-label" },
      { raw: "「超級狀元」", classification: "label", classificationReason: "short-label" },
      { raw: "「好。」", classification: "direct", classificationReason: "attribution" },
    ]);

    const result = validateQuotationPreservation(text, "今屆有24名狀元，其中11名超級狀元。黃同學說：「好。」");
    expect(result.valid).toBe(true);
    expect(result.sourceDirectQuotations).toHaveLength(1);
    expect(result.ignoredSourceLabels).toHaveLength(2);
  });

  it("records nesting and paragraphs while containing malformed quotations", () => {
    const nested = extractQuotationSpans("甲說：「外層提到『內層詞語』，內容完整。」");
    expect(nested.map(({ raw, depth }) => ({ raw, depth }))).toEqual([
      { raw: "「外層提到『內層詞語』，內容完整。」", depth: 0 },
      { raw: "『內層詞語』", depth: 1 },
    ]);

    const malformed = "第一段說：「未完\n\n第二段說：「完整內容。」";
    const recovered = extractQuotationSpans(malformed);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ raw: "「完整內容。」", paragraph: 2, depth: 0 });
  });
});

describe("quotation preservation validation", () => {
  it("accepts delimiter variants, CRLF/LF, NFC, and boundary whitespace", () => {
    const source = "發言人說：「 cafe\u0301\r\n 仍然營業。 」";
    const rewrite = "發言人說：“café\n 仍然營業。”";

    expect(canonicalizeQuotationContent(" cafe\u0301\r\n 仍然營業。 ")).toBe(
      "café\n 仍然營業。",
    );
    expect(validateQuotationPreservation(source, rewrite)).toMatchObject({
      valid: true,
      issues: [],
    });
  });

  it("normalizes compatibility punctuation without relaxing quoted wording", () => {
    const source = "發言人說：「安排維持不變，明日開始。」";
    const rewrite = "發言人說：“安排維持不變,明日開始︒”";

    expect(validateQuotationPreservation(source, rewrite)).toMatchObject({
      valid: true,
      issues: [],
    });
  });

  it("protects short attributed and medium Chinese quotations while ignoring labels", () => {
    const source =
      "他受經歷啟發從醫，「將來都要做咁樣嘅醫生」。5名狀元認為是「人」的問題。她直言最想「返屋企瞓覺」。";
    const spans = extractQuotationSpans(source);

    expect(spans.map(({ raw, classification }) => ({ raw, classification }))).toEqual([
      { raw: "「將來都要做咁樣嘅醫生」", classification: "direct" },
      { raw: "「人」", classification: "label" },
      { raw: "「返屋企瞓覺」", classification: "direct" },
    ]);
  });

  it("keeps a short quoted label classified as a label when attribution appears later", () => {
    const spans = extractQuotationSpans(
      "5名狀元均認為是「人」的問題，蔡善行強調醫療操守須靠醫生自律。",
    );

    expect(spans).toMatchObject([
      { raw: "「人」", classification: "label", classificationReason: "short-label" },
    ]);
  });

  it("reports changed internal punctuation with the candidate and location", () => {
    const result = validateQuotationPreservation(
      "甲說：「維持原定安排。」",
      "甲說：“維持原定安排！”",
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      kind: "punctuation_changed",
      paragraph: 1,
      candidateParagraph: 1,
      source: { raw: "「維持原定安排。」" },
      candidate: { raw: "“維持原定安排！”" },
    });
    expect(result.issues[0].difference).toContain("Internal punctuation changed");
    expect(result.issues[0].action).toContain("punctuation");
  });

  it("reports modified wording and both approximate paragraph locations", () => {
    const result = validateQuotationPreservation(
      "導言。\n\n發言人說：「計劃將於九月開始。」",
      "導言。\n\n發言人說：“計劃將於十月開始。”",
    );

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      kind: "modified",
      paragraph: 2,
      candidateParagraph: 2,
      source: { raw: "「計劃將於九月開始。」" },
      candidate: { raw: "“計劃將於十月開始。”" },
    });
    expect(result.issues[0].difference).toMatch(/character.*source:.*九.*rewrite:.*十/u);
    expect(result.issues[0].action).toContain("Restore the source quotation exactly");
  });

  it("reports an omitted quotation with a concrete action", () => {
    const result = validateQuotationPreservation(
      "發言人說：「完整引語必須保留。」",
      "發言人概述了原定安排。",
    );

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      kind: "omitted",
      paragraph: 1,
      candidate: undefined,
      candidateQuotes: [],
    });
    expect(result.issues[0].difference).toContain("No corresponding quotation");
    expect(result.issues[0].action).toContain("Reinsert");
  });

  it("identifies a source quotation split across rewrite quotations", () => {
    const result = validateQuotationPreservation(
      "甲說：「第一句，第二句。」",
      "甲說：「第一句，」「第二句。」",
    );

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      kind: "split",
      source: { raw: "「第一句，第二句。」" },
    });
    expect(result.issues[0].candidateQuotes.map(({ raw }) => raw)).toEqual([
      "「第一句，」",
      "「第二句。」",
    ]);
    expect(result.issues[0].difference).toContain("split across 2");
  });

  it("identifies multiple source quotations merged in the rewrite", () => {
    const result = validateQuotationPreservation(
      "甲說：「甲句。」乙回答：「乙句。」",
      "甲說：「甲句。乙句。」",
    );

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      kind: "merged",
      candidate: { raw: "「甲句。乙句。」" },
    });
    expect(result.issues[0].sourceQuotes.map(({ raw }) => raw)).toEqual([
      "「甲句。」",
      "「乙句。」",
    ]);
    expect(result.issues[0].difference).toContain("2 source quotations were merged");
  });

  it("allocates duplicate quotations one-to-one", () => {
    const source = "甲說：「保持原文。」乙回答：「保持原文。」";
    const oneOccurrence = validateQuotationPreservation(source, "甲說：「保持原文。」");
    const twoOccurrences = validateQuotationPreservation(
      source,
      "甲說：「保持原文。」乙回答：「保持原文。」",
    );

    expect(oneOccurrence.valid).toBe(false);
    expect(oneOccurrence.issues).toHaveLength(1);
    expect(oneOccurrence.issues[0].kind).toBe("omitted");
    expect(twoOccurrences).toMatchObject({ valid: true, issues: [] });
  });

  it("does not double-count a protected outer quotation when it contains a nested label", () => {
    const source = "甲說：「外層提到『內層詞語』，內容完整。」";
    const rewrite = "甲說：“外層提到『內層詞語』，內容完整。”";
    const result = validateQuotationPreservation(source, rewrite);

    expect(result.sourceDirectQuotations.map(({ raw }) => raw)).toEqual([
      "「外層提到『內層詞語』，內容完整。」",
    ]);
    expect(result).toMatchObject({ valid: true, issues: [] });
  });
});
