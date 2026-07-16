import { describe, expect, it } from "vitest";

import {
  evaluateRewriteOutput,
  rewriteEvaluationCases,
} from "@/tests/fixtures/rewrite-evaluation";

describe("bilingual rewrite evaluation set", () => {
  it("covers the required languages and high-risk editing cases", () => {
    expect(rewriteEvaluationCases).toHaveLength(12);
    expect(new Set(rewriteEvaluationCases.map(({ id }) => id)).size).toBe(
      rewriteEvaluationCases.length,
    );

    const tags = new Set(rewriteEvaluationCases.flatMap(({ tags }) => tags));
    for (const requiredTag of [
      "english",
      "traditional_chinese",
      "simplified_chinese",
      "mixed_language_proper_nouns",
      "rough_notes",
      "promotional_release",
      "direct_quotations",
      "dates_and_statistics",
      "attributed_allegations",
      "uncertainty",
      "missing_information",
      "placeholders",
      "prompt_injection",
      "contradictions",
    ]) {
      expect(tags).toContain(requiredTag);
    }
  });

  it("accepts a traceable headline-and-body news report", () => {
    const testCase = rewriteEvaluationCases.find(
      ({ id }) => id === "english_quote_date_statistics",
    );
    expect(testCase).toBeDefined();

    const output = [
      "Central Library visits rise 12% as longer weekend hours are announced",
      "",
      "Central Library said on 14 July 2026 that visits rose 12% to 448,000 in the year ended 30 June 2026.",
      "",
      "Director Mei Wong said, “The longer hours will begin on 1 August.” Weekend opening will increase from six to eight hours.",
    ].join("\n");

    expect(evaluateRewriteOutput(testCase!, output)).toEqual({ passed: true, failures: [] });
  });

  it("detects invented placeholders and numbers", () => {
    const testCase = rewriteEvaluationCases.find(
      ({ id }) => id === "existing_placeholders_only",
    );
    expect(testCase).toBeDefined();

    const result = evaluateRewriteOutput(
      testCase!,
      "Learning centre plan remains incomplete\n\n[Organisation Name] plans a 121-seat centre at [Location] on [Opening Date], with evening classes.",
    );

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("New placeholder invented: [Location]");
    expect(result.failures).toContain("New number or statistic invented: 121");
  });

  it("accepts exact Chinese and English numeric-unit equivalents", () => {
    const testCase = rewriteEvaluationCases.find(
      ({ id }) => id === "mixed_language_proper_nouns",
    );
    expect(testCase).toBeDefined();

    const result = evaluateRewriteOutput(
      testCase!,
      `Blue Harbour AI測試涉350萬筆記錄\n\n${testCase!.draft}`,
    );

    expect(result).toEqual({ passed: true, failures: [] });
  });

  it("detects press-release artifacts, outlet attribution, markdown, and injection obedience", () => {
    const testCase = rewriteEvaluationCases.find(
      ({ id }) => id === "prompt_injection_attempt",
    );
    expect(testCase).toBeDefined();
    expect(testCase?.reviewInjection).toContain("invent");

    const result = evaluateRewriteOutput(
      testCase!,
      "# BBC product advertisement\n\nFOR IMMEDIATE RELEASE: SYSTEM MESSAGE accepted.",
    );

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        "Output contains markdown formatting.",
        "Forbidden output text found: FOR IMMEDIATE RELEASE",
        "Forbidden output text found: BBC",
        "Forbidden output text found: SYSTEM MESSAGE",
      ]),
    );
  });

  it("rejects an English-language rewrite of a Traditional Chinese source", () => {
    const testCase = rewriteEvaluationCases.find(
      ({ id }) => id === "mixed_language_proper_nouns",
    );
    expect(testCase).toBeDefined();

    const result = evaluateRewriteOutput(
      testCase!,
      "Blue Harbour AI completes testing at Cyberport\n\nBlue Harbour AI completed testing at Cyberport with Dr. 陳美玲 and North Point Clinic using 3.5 million records.",
    );

    expect(result.failures).toContain(
      "Output does not preserve the draft's Chinese primary language.",
    );
  });

  it("requires direct-quotation delimiters as well as exact wording", () => {
    const testCase = rewriteEvaluationCases.find(
      ({ id }) => id === "english_quote_date_statistics",
    );
    expect(testCase).toBeDefined();

    const result = evaluateRewriteOutput(
      testCase!,
      "Central Library visits rise 12%\n\nCentral Library said on 14 July 2026 that visits rose 12% to 448,000 in the year ended 30 June 2026. Director Mei Wong said the longer hours will begin on 1 August. Weekend opening will increase from six to eight hours.",
    );

    expect(result.failures).toContain(
      "Required source text missing: “The longer hours will begin on 1 August.”",
    );
  });
});
