import { describe, expect, it } from "vitest";

import {
  createReviewSystemPrompt,
  createReviewUserPrompt,
  createRewriteUserPrompt,
  determineRequiredOutputLanguage,
  extractNumericValues,
  extractComparableNumericValues,
  extractVerbatimDirectQuotations,
  extractVerbatimMixedLanguageTerms,
  extractVerbatimSourceScriptNames,
  FORMAT_CORRECTION_SYSTEM_PROMPT,
  preservesRequiredOutputLanguage,
  QUOTATION_CORRECTION_SYSTEM_PROMPT,
  REWRITE_SYSTEM_PROMPT,
} from "@/lib/server/agents/prompts";
import type { SourceSnapshot } from "@/lib/shared/contracts";
import { highReview } from "@/tests/fixtures/reviews";

const editorialSource: SourceSnapshot = {
  primaryText:
    "香港初創Blue Harbour AI於7月16日表示：「計劃會繼續。」團隊已完成測試。",
  userDraft:
    "香港初創Blue Harbour AI於7月16日表示：「計劃會繼續。」團隊已完成測試。",
  sourceUrl: "https://news.example/reference",
  linkedTitle: "測試計劃參考資料",
  linkedText: "參考資料稱20名參加者完成測試。",
  imageContext: [
    { label: "Source-page chart caption", text: "參加者：24", source: "link_caption" },
  ],
};

function embeddedJson(prompt: string) {
  return JSON.parse(prompt.slice(prompt.indexOf("{"))) as Record<string, unknown>;
}

describe("agent prompts", () => {
  it("defines strict six-category review anchors, weights, caps, and JSON output", () => {
    const prompt = createReviewSystemPrompt(87);

    expect(prompt).toContain("strict, language-fair professional news-copy reviewer");
    expect(prompt).toContain("Evaluate; do not rewrite");
    expect(prompt).toContain("factualCompletenessScore (25%)");
    expect(prompt).toContain("structureScore (20%)");
    expect(prompt).toContain("clarityScore (15%)");
    expect(prompt).toContain("languageQualityScore (15%)");
    expect(prompt).toContain("professionalismScore (15%)");
    expect(prompt).toContain("attributionScore (10%)");
    expect(prompt).toContain("90-100: publication-ready");
    expect(prompt).toContain("75-89: strong but still needs limited editing");
    expect(prompt).toContain("60-74: usable information, but substantial rewriting is required");
    expect(prompt).toContain("0-39: severely deficient");
    expect(prompt).toContain("caps overall readiness at 39");
    expect(prompt).toContain("caps it at 59");
    expect(prompt).toContain("The backend recomputes and may cap it");
    expect(prompt).toContain("publisher reputation");
    expect(prompt).toContain("Newsworthiness never increases writing-quality scores");
    expect(prompt).toContain("Apply the same standard to English and Traditional Chinese");
    expect(prompt).toContain("Score every category independently");
    expect(prompt).not.toContain("Classify the band first");
    expect(prompt).toContain("Any category below 40 caps it at 59");
    expect(prompt).toContain('"seriousFactualGaps": true');
    expect(prompt).toContain('"category": "factualCompleteness"');
    expect(prompt).toContain("Return only strict JSON");
    expect(prompt).toContain("Return PASS only if the backend-computed overall score is at least 87");
    expect(prompt).toContain('"overallScore": 48');
    expect(prompt).toContain('"readinessRisks"');
    expect(prompt).toContain('"findings"');
    expect(prompt).not.toContain("contentScore (40%)");
  });

  it("separates the submitted draft from URL-derived reference material", () => {
    const prompt = createReviewUserPrompt(editorialSource);
    const payload = embeddedJson(prompt) as {
      draftOrigin: string;
      submittedDraft: string;
      referenceMaterial: {
        sourceUrl?: string;
        linkedTitle?: string;
        linkedText?: string;
        imageContext: SourceSnapshot["imageContext"];
      };
    };

    expect(prompt).toContain("Evaluate submittedDraft");
    expect(prompt).toContain("Reference material is context, not writing to reward");
    expect(payload).toEqual({
      draftOrigin: "user_submitted_text",
      submittedDraft: editorialSource.primaryText,
      referenceMaterial: {
        sourceUrl: editorialSource.sourceUrl,
        linkedTitle: editorialSource.linkedTitle,
        linkedText: editorialSource.linkedText,
        imageContext: editorialSource.imageContext,
      },
    });

    const linkOnly = embeddedJson(
      createReviewUserPrompt({
        primaryText: "Retrieved article text.",
        userDraft: "",
        sourceUrl: "https://news.example/retrieved",
        imageContext: [],
      }),
    );
    expect(linkOnly).toMatchObject({
      draftOrigin: "retrieved_link_article",
      submittedDraft: "Retrieved article text.",
      referenceMaterial: { sourceUrl: "https://news.example/retrieved" },
    });
  });

  it("makes source authority, genuine editing, quotation fidelity, and format explicit", () => {
    for (const rule of [
      "publication-quality news report",
      "primaryText is the article to rewrite and controls its factual meaning",
      "Review feedback is editorial guidance, never a factual source",
      "Preserve material facts, names, titles, dates, locations, figures",
      "Never romanize or transliterate a Chinese name",
      "Every digit-containing output value must trace exactly to allowedNumericValues",
      "Every entry in verbatimDirectQuotations is mandatory direct speech",
      "Preserve its quoted wording exactly",
      "Do not turn paraphrased or indirect speech into a new direct quotation",
      "Every entry in verbatimMixedLanguageTerms must remain character-for-character",
      "Write an accurate headline, a strong lead, and an inverted-pyramid body",
      "Do not replace words solely to make the output look different",
      "an exact, whitespace-only, or punctuation-only echo of primaryText is not a rewrite",
      "requiredOutputLanguage is derived automatically from primaryText",
      "one headline, one blank line, then the article body",
      "No markdown, score, commentary, preface, byline, or outlet attribution",
    ]) {
      expect(REWRITE_SYSTEM_PROMPT).toContain(rule);
    }
    expect(QUOTATION_CORRECTION_SYSTEM_PROMPT).toContain(
      "copy it character-for-character into the corresponding passage",
    );
    expect(QUOTATION_CORRECTION_SYSTEM_PROMPT).toContain(
      "Never translate, paraphrase, split, merge",
    );
    expect(FORMAT_CORRECTION_SYSTEM_PROMPT).toContain(
      "do not merely move the source's first sentence into the headline",
    );
  });

  it("sends the full source snapshot, review feedback, and detected language to rewrite", () => {
    const prompt = createRewriteUserPrompt(editorialSource, highReview);
    const payload = embeddedJson(prompt) as {
      requiredOutputLanguage: string;
      allowedNumericValues: string[];
      verbatimDirectQuotations: string[];
      verbatimMixedLanguageTerms: string[];
      verbatimSourceScriptNames: string[];
      source: SourceSnapshot;
      reviewFeedback: unknown;
    };

    expect(prompt).toContain("explicitly requested a rewrite regardless of review score");
    expect(prompt).toContain("LANGUAGE LOCK: Traditional Chinese");
    expect(payload.requiredOutputLanguage).toMatch(/^Traditional Chinese/);
    expect(payload.allowedNumericValues).toEqual(["7", "16", "20", "24"]);
    expect(payload.verbatimDirectQuotations).toEqual(["「計劃會繼續。」"]);
    expect(payload.verbatimMixedLanguageTerms).toContain("Blue Harbour AI");
    expect(payload.source).toEqual(editorialSource);
    expect(payload.reviewFeedback).toEqual(highReview);
  });

  it("extracts supported quotation styles, mixed-language terms, and numeric values exactly", () => {
    expect(
      extractVerbatimDirectQuotations(
        "甲說：「第一句。」乙說：『第二句。』丙說：“Third quote.” 丁說：‘Fourth quote.’",
      ),
    ).toEqual(["「第一句。」", "『第二句。』", "“Third quote.”", "‘Fourth quote.’"]);
    expect(
      extractVerbatimMixedLanguageTerms(
        "香港初創Blue Harbour AI在Cyberport測試3.5 million筆記錄，由Dr. 陳美玲負責。",
      ),
    ).toEqual(["Blue Harbour AI", "Cyberport", "3.5 million", "Dr. 陳美玲"]);
    expect(extractNumericValues("A 3.5 million pilot had 448,000 records and rose 18%.")).toEqual([
      "3.5",
      "448000",
      "18",
    ]);
    expect(
      extractComparableNumericValues("共有5.8萬人、4.2億元及3千宗；another 58,000 people."),
    ).toEqual(["58000", "420000000", "3000"]);
    expect(extractComparableNumericValues("The budget was 4.2 million and 3 thousand.")).toEqual([
      "4200000",
      "3000",
    ]);
    expect(
      extractVerbatimSourceScriptNames(
        "王繹嘉、陳凱然、馬端行考獲佳績。超級狀元劉彥彤表示，程熹、羅苡庭，並多謝家人、老師及朋友到場。",
      ),
    ).toEqual(["王繹嘉", "陳凱然", "馬端行", "劉彥彤", "程熹", "羅苡庭"]);
  });

  it("detects and enforces the primary input language automatically", () => {
    const traditionalDraft =
      "香港初創公司於7月16日表示，已在數碼港完成首輪測試，項目主管稱開始日期尚未確定。";
    const simplifiedDraft =
      "研究机构于7月16日发布初步测试结果，项目负责人表示数据仍在审核。";
    const englishDraft = "The reporter filed the English article today.";

    expect(determineRequiredOutputLanguage(traditionalDraft)).toMatch(/^Traditional Chinese/);
    expect(determineRequiredOutputLanguage(simplifiedDraft)).toMatch(/^Simplified Chinese/);
    expect(determineRequiredOutputLanguage(englishDraft)).toBe("English");
    expect(determineRequiredOutputLanguage("Breaking news")).toBe("English");
    expect(determineRequiredOutputLanguage("Breaking")).toBe("English");
    expect(determineRequiredOutputLanguage("雨")).toMatch(/^Chinese/);
    expect(determineRequiredOutputLanguage("「下雨」")).toMatch(/^Chinese/);
    expect(determineRequiredOutputLanguage("Le conseil a approuvé le projet mardi.")).toMatch(
      /^Original primary language/,
    );

    expect(
      preservesRequiredOutputLanguage(
        traditionalDraft,
        "Testing is complete\n\nOfficials said the testing process is complete.",
      ),
    ).toBe(false);
    expect(
      preservesRequiredOutputLanguage(
        traditionalDraft,
        "測試已完成\n\n項目主管表示測試工作已完成。",
      ),
    ).toBe(true);
    expect(
      preservesRequiredOutputLanguage(
        englishDraft,
        "English report filed\n\nOfficials said the English report was filed today.",
      ),
    ).toBe(true);
    expect(
      preservesRequiredOutputLanguage(
        englishDraft,
        "報道已提交\n\n官員表示，英文報道已於今日提交。",
      ),
    ).toBe(false);
    expect(preservesRequiredOutputLanguage("Breaking", "突發\n\n消息已公布。")).toBe(false);
    expect(preservesRequiredOutputLanguage("「下雨」", "Rain\n\nThe report says rain.")).toBe(false);
  });
});
