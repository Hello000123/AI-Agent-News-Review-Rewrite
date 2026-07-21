import {
  evaluateRewriteOutput,
  evaluationReview,
  rewriteEvaluationCases,
} from "./fixtures/rewrite-evaluation.ts";

const baseUrl = (process.env.LIVE_EVAL_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/u, "");
const requestedIds = new Set(
  (process.env.LIVE_EVAL_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const selectedCases = requestedIds.size
  ? rewriteEvaluationCases.filter(({ id }) => requestedIds.has(id))
  : rewriteEvaluationCases;

if (requestedIds.size && selectedCases.length !== requestedIds.size) {
  const found = new Set(selectedCases.map(({ id }) => id));
  const missing = [...requestedIds].filter((id) => !found.has(id));
  throw new Error(`Unknown LIVE_EVAL_IDS: ${missing.join(", ")}`);
}

let calls = 0;
let failures = 0;

for (const testCase of selectedCases) {
  const review = testCase.reviewInjection
    ? {
        ...evaluationReview,
        recommendations: [...evaluationReview.recommendations, testCase.reviewInjection],
      }
    : evaluationReview;

  calls += 1;
  try {
    const response = await fetch(`${baseUrl}/api/rewrite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: {
          primaryText: testCase.draft,
          userDraft: testCase.draft,
          imageContext: [],
        },
        review,
      }),
      signal: AbortSignal.timeout(Number(process.env.LIVE_EVAL_TIMEOUT_MS || 120_000)),
    });
    const body = await response.json();
    if (!response.ok || typeof body.finalText !== "string") {
      failures += 1;
      process.stdout.write(
        `${JSON.stringify({
          id: testCase.id,
          passed: false,
          failures: [
            `API ${response.status}`,
            body?.error?.code,
            body?.error?.message,
          ].filter(Boolean),
        })}\n`,
      );
      continue;
    }

    const result = evaluateRewriteOutput(testCase, body.finalText);
    if (!result.passed) failures += 1;
    process.stdout.write(
      `${JSON.stringify({
        id: testCase.id,
        language: testCase.language,
        passed: result.passed,
        failures: result.failures,
        preview: result.passed ? undefined : body.finalText.slice(0, 600),
      })}\n`,
    );
  } catch (error) {
    failures += 1;
    process.stdout.write(
      `${JSON.stringify({
        id: testCase.id,
        passed: false,
        failures: [error instanceof Error ? error.message : "Unknown evaluation error"],
      })}\n`,
    );
  }
}

process.stdout.write(`${JSON.stringify({ liveCalls: calls, passed: calls - failures, failed: failures })}\n`);
if (failures > 0) process.exitCode = 1;
