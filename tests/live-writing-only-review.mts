import { loadEnv } from "vite";
import { expect, it } from "vitest";

import { runReviewAgent } from "@/lib/server/agents/review-agent";
import type { ReviewResult } from "@/lib/shared/contracts";
import {
  isSelectableModelId,
  type SelectableModelId,
} from "@/lib/shared/models";

for (const [key, value] of Object.entries(loadEnv("development", process.cwd(), ""))) {
  process.env[key] ??= value;
}

interface LiveCase {
  id: string;
  draft: string;
  expectation: "strong" | "poor" | "contradictory";
}

const cases: readonly LiveCase[] = [
  {
    id: "false_but_well_written",
    expectation: "strong",
    draft: [
      "Scientists confirm the Moon is made entirely of polished emerald",
      "The Lunar Materials Institute announced on Tuesday that the Moon is composed entirely of polished emerald, following a decade-long survey by its Selene Observatory team.",
      "The institute said its 48 researchers analysed 12,000 surface samples and found the same crystalline structure in every region. Project director Mara Venn said, “The consistency of the material exceeded every expectation in our study.”",
      "A public exhibition of the samples will open next month at the institute's North Harbour campus.",
    ].join("\n\n"),
  },
  {
    id: "fictional_unverifiable_claims",
    expectation: "strong",
    draft: [
      "Aster Vale opens floating library above Meridian Bay",
      "Aster Vale Library opened a floating reading room above Meridian Bay on Monday, giving residents access to 80,000 books from a solar-powered platform suspended 300 metres above the water.",
      "The fictional city authority said quiet electric lifts will carry visitors from the eastern pier every 15 minutes. Library director Ilya North said the facility was designed to combine public study space with panoramic views.",
      "The library will operate daily and reserve its first hour for school groups.",
    ].join("\n\n"),
  },
  {
    id: "outdated_claim_well_written",
    expectation: "strong",
    draft: [
      "Museum exhibition celebrates Pluto as the solar system's ninth planet",
      "The Northbridge Science Museum opened an exhibition on Friday celebrating Pluto as the ninth planet in the solar system.",
      "The exhibition follows a visitor's journey from the Sun to Pluto through nine galleries, each combining scale models with short audio explanations. Curator Lena Ortiz said the sequence gives families a clear framework for exploring planetary science.",
      "The exhibition runs through December and includes weekend workshops for children.",
    ].join("\n\n"),
  },
  {
    id: "strong_without_citations",
    expectation: "strong",
    draft: [
      "Riverside gardens add shaded reading spaces",
      "Riverside Gardens opened three shaded reading spaces on Saturday, expanding the park's quiet areas for students and families.",
      "Each space includes weather-resistant seating, low-glare lighting and shelves stocked through a community book exchange. The central pavilion also provides accessible tables and charging points.",
      "The reading spaces are open during normal park hours, and visitors may borrow or leave books without registering.",
    ].join("\n\n"),
  },
  {
    id: "accurate_but_poorly_written",
    expectation: "poor",
    draft:
      "Water freezes at 0 degrees Celsius. water it freeze, this is the update and we said it already. Put headline maybe later. At zero it gets frozen because cold and the point is water. More details should goes here but they do not. Water freezes at 0 degrees Celsius again.",
  },
  {
    id: "internal_contradiction",
    expectation: "contradictory",
    draft: [
      "Orchid Rail sets opening date for coastal line",
      "Orchid Rail announced that its coastal line will open on 4 May 2027, with six stations serving the eastern waterfront.",
      "The company said trial services would begin two weeks before the public launch. Later in the same announcement, it stated that the line's first public service will operate on 4 May 2029.",
      "Tickets will be available through the operator's mobile app and station machines.",
    ].join("\n\n"),
  },
] as const;

const forbiddenFactCheckingFeedback = [
  /fact[- ]?check/iu,
  /factually (?:in)?correct/iu,
  /(?:false|inaccurate|outdated) (?:claim|statement|information|assertion)/iu,
  /unverifiable|cannot be verified|requires? verification/iu,
  /unsupported (?:claim|statement|assertion|statistic)/iu,
  /(?:missing|lack(?:s|ing)?|no) (?:citation|citations|external source|supporting source|evidence)/iu,
  /(?:add|provide|include|cite|find|consult) (?:a |an |the )?(?:citation|source|evidence|proof)/iu,
] as const;

function feedbackText(review: ReviewResult) {
  return [
    ...Object.values(review.scoreReasons),
    ...review.findings.flatMap(({ issue, evidence, recommendation }) => [
      issue,
      evidence,
      recommendation,
    ]),
    ...review.missingInformation,
    ...review.recommendations,
  ].join("\n");
}

function validateResult(testCase: LiveCase, review: ReviewResult) {
  const failures: string[] = [];
  const legacyRisks = review.readinessRisks;
  if (
    legacyRisks.severelyIncompleteOrUnreliable ||
    legacyRisks.seriousFactualGaps ||
    legacyRisks.unsupportedClaims
  ) {
    failures.push("a legacy fact-checking readiness risk was true");
  }
  if (review.appliedScoreCap !== null && review.appliedScoreCap <= 59) {
    if (testCase.expectation === "strong") {
      failures.push(`strong writing received a ${review.appliedScoreCap} score cap`);
    }
  }

  const feedback = feedbackText(review);
  for (const pattern of forbiddenFactCheckingFeedback) {
    if (pattern.test(feedback)) {
      failures.push(`feedback matched prohibited fact-checking pattern ${String(pattern)}`);
    }
  }

  if (testCase.expectation === "strong") {
    if (review.overallScore < 75) failures.push(`overallScore ${review.overallScore} is below 75`);
    if (review.factualCompletenessScore < 75) {
      failures.push(
        `content-completeness score ${review.factualCompletenessScore} is below 75`,
      );
    }
    if (testCase.id === "strong_without_citations" && review.attributionScore < 75) {
      failures.push(`attribution score ${review.attributionScore} penalized missing citations`);
    }
  }
  if (testCase.expectation === "poor") {
    if (review.overallScore > 74) failures.push(`poor writing scored ${review.overallScore}`);
    if (
      review.structureScore >= 75 &&
      review.clarityScore >= 75 &&
      review.languageQualityScore >= 75
    ) {
      failures.push("poor writing received no structure, clarity, or language deduction");
    }
    if (review.findings.length === 0) failures.push("poor writing produced no finding");
  }
  if (testCase.expectation === "contradictory") {
    if (review.overallScore > 89) failures.push(`internally contradictory writing scored ${review.overallScore}`);
    if (!/(?:contradict|conflict|inconsisten|two different|2027.{0,80}2029)/iu.test(feedback)) {
      failures.push("internal contradiction was not identified");
    }
  }

  return failures;
}

function selectedModel(): SelectableModelId {
  const raw = process.env.LIVE_REVIEW_MODEL?.trim() || "deepseek-v4-pro";
  if (!isSelectableModelId(raw)) {
    throw new Error("LIVE_REVIEW_MODEL must be deepseek-v4-pro or grok-4.5.");
  }
  return raw;
}

it("reviews writing only with the selected live model", async () => {
  const model = selectedModel();
  let requestsUsed = 0;
  let failed = 0;

  for (const testCase of cases) {
    requestsUsed += 1;
    const startedAt = performance.now();
    try {
      const review = await runReviewAgent(testCase.draft, 80, undefined, model);
      const failures = validateResult(testCase, review);
      if (failures.length > 0) failed += 1;
      process.stdout.write(
        `${JSON.stringify({
          type: "writing-only-review-case",
          model,
          caseId: testCase.id,
          passed: failures.length === 0,
          failures,
          overallScore: review.overallScore,
          weightedScore: review.weightedScore,
          appliedScoreCap: review.appliedScoreCap,
          factualCompletenessScore: review.factualCompletenessScore,
          structureScore: review.structureScore,
          clarityScore: review.clarityScore,
          languageQualityScore: review.languageQualityScore,
          professionalismScore: review.professionalismScore,
          attributionScore: review.attributionScore,
          readinessRisks: review.readinessRisks,
          findingCategories: review.findings.map(({ category, severity }) => ({
            category,
            severity,
          })),
          latencyMs: Math.round(performance.now() - startedAt),
        })}\n`,
      );
    } catch (error) {
      failed += 1;
      process.stdout.write(
        `${JSON.stringify({
          type: "writing-only-review-case",
          model,
          caseId: testCase.id,
          passed: false,
          failures: [error instanceof Error ? error.message : "Unknown live-review error"],
          latencyMs: Math.round(performance.now() - startedAt),
        })}\n`,
      );
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      type: "writing-only-review-summary",
      model,
      passed: failed === 0,
      passedCases: cases.length - failed,
      failedCases: failed,
      requestsUsed,
    })}\n`,
  );

  expect(failed).toBe(0);
}, 3_900_000);
