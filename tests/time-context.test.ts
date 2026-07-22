import { describe, expect, it } from "vitest";

import { analyzeTimeContext } from "@/lib/server/agents/time-context";

describe("time-context presence analysis", () => {
  it("recognizes exact English and Chinese calendar dates", () => {
    const analysis = analyzeTimeContext(
      "The first briefing was held on 22 July 2026 and a follow-up was set for July 23, 2026. " +
        "另一場簡報會於2026年7月24日舉行，紀錄日期為2026-07-25。",
    );

    expect(analysis.exactDateExpressions).toEqual([
      "22 July 2026",
      "July 23, 2026",
      "2026年7月24日",
      "2026-07-25",
    ]);
    expect(analysis.relativeTimeExpressions).toEqual([]);
  });

  it("recognizes every specified English relative time expression", () => {
    const analysis = analyzeTimeContext(
      "Yesterday the company referred to work completed today and recently. " +
        "Earlier this week it discussed last week, this morning and on Monday.",
    );

    expect(analysis.relativeTimeExpressions).toEqual([
      "Yesterday",
      "today",
      "recently",
      "Earlier this week",
      "last week",
      "this morning",
      "on Monday",
    ]);
  });

  it("recognizes every specified Traditional Chinese relative time expression", () => {
    const analysis = analyzeTimeContext(
      "公司昨天、今日、近日及近期均有公布，本週較早時和上星期亦曾交代，今早再確認星期一的安排。",
    );

    expect(analysis.relativeTimeExpressions).toEqual([
      "昨天",
      "今日",
      "近日",
      "近期",
      "本週較早時",
      "上星期",
      "今早",
      "星期一",
    ]);
  });

  it("returns an empty compact analysis when no date or time signal is present", () => {
    expect(analyzeTimeContext("The company announced the programme.")).toEqual({
      exactDateExpressions: [],
      relativeTimeExpressions: [],
      uncertaintyCues: [],
      contradictionCues: [],
    });
  });

  it("reports explicit uncertainty and contradiction cues without judging them", () => {
    const analysis = analyzeTimeContext(
      "The programme began yesterday—or perhaps today. The accounts are contradictory and the date is unconfirmed. " +
        "公司稱日期尚未確定，兩份時間表前後不一。",
    );

    expect(analysis.relativeTimeExpressions).toEqual(["yesterday", "today"]);
    expect(analysis.uncertaintyCues).toEqual(["perhaps", "unconfirmed", "尚未確定"]);
    expect(analysis.contradictionCues).toEqual(["contradictory", "前後不一"]);
    expect(analysis).not.toHaveProperty("isRelevant");
    expect(analysis).not.toHaveProperty("isValid");
  });

  it("deduplicates repeated signals while preserving their first source form and order", () => {
    const analysis = analyzeTimeContext(
      "Today the company repeated today, then referred to 今日 twice: 今日。",
    );

    expect(analysis.relativeTimeExpressions).toEqual(["Today", "今日"]);
  });
});
