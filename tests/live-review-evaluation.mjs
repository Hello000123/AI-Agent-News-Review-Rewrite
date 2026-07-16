import {
  REVIEW_EVALUATION_REQUEST_PARAMETERS,
  evaluateReviewComparisons,
  evaluateReviewResult,
  evaluateReviewRuns,
  reviewEvaluationCases,
  reviewEvaluationComparisons,
} from "./fixtures/review-evaluation.ts";

const baseUrl = (
  process.env.REVIEW_EVAL_BASE_URL ||
  process.env.LIVE_EVAL_BASE_URL ||
  "http://127.0.0.1:3000"
).replace(/\/+$/u, "");

function integerSetting(name, fallback, minimum, maximum) {
  const rawValue = process.env[name];
  if (!rawValue?.trim()) return fallback;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

const requestedRuns = integerSetting("EVAL_RUNS", 2, 1, 10);
const timeoutMs = integerSetting("REVIEW_EVAL_TIMEOUT_MS", 180_000, 1_000, 600_000);
const requestedIds = new Set(
  (process.env.EVAL_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const selectedCases = requestedIds.size
  ? reviewEvaluationCases.filter(({ id }) => requestedIds.has(id))
  : reviewEvaluationCases;

if (requestedIds.size && selectedCases.length !== requestedIds.size) {
  const selectedIds = new Set(selectedCases.map(({ id }) => id));
  const unknownIds = [...requestedIds].filter((id) => !selectedIds.has(id));
  throw new Error(`Unknown EVAL_IDS: ${unknownIds.join(", ")}`);
}

const explicitEvalModel = process.env.EVAL_MODEL?.trim();
const configuredModel = process.env.DEEPSEEK_MODEL?.trim();
const modelIdentifier = explicitEvalModel || configuredModel || "server-configured-model";
const modelIdentifierSource = explicitEvalModel
  ? "EVAL_MODEL"
  : configuredModel
    ? "DEEPSEEK_MODEL"
    : "response-assumption";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const scoreKeys = [
  "factualCompletenessScore",
  "structureScore",
  "clarityScore",
  "languageQualityScore",
  "professionalismScore",
  "attributionScore",
];

function isReviewResultShape(value) {
  if (!isRecord(value)) return false;
  if (!scoreKeys.every((key) => typeof value[key] === "number")) return false;
  if (typeof value.weightedScore !== "number" || typeof value.overallScore !== "number") {
    return false;
  }
  if (value.appliedScoreCap !== null && typeof value.appliedScoreCap !== "number") return false;
  if (!Array.isArray(value.scoreCapReasons) || !Array.isArray(value.findings)) return false;
  if (!isRecord(value.readinessRisks)) return false;
  if (typeof value.readinessBand !== "string" || typeof value.decision !== "string") return false;
  return true;
}

function scoreRecord(review) {
  return Object.fromEntries(scoreKeys.map((key) => [key, review[key]]));
}

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function safeFetchError(error) {
  if (error instanceof DOMException) return error.name;
  return error instanceof TypeError ? "FETCH_ERROR" : "UNKNOWN_FETCH_ERROR";
}

emit({
  type: "review-eval-config",
  caseCount: selectedCases.length,
  runsPerCase: requestedRuns,
  modelIdentifier,
  modelIdentifierSource,
  requestParameters: REVIEW_EVALUATION_REQUEST_PARAMETERS,
});

let attemptedRuns = 0;
let successfulApiRuns = 0;
let failedCases = 0;
const medianScoresByCase = {};
const selectedCaseIds = new Set(selectedCases.map(({ id }) => id));

for (const testCase of selectedCases) {
  const successfulReviews = [];
  let caseTransportOrParseFailure = false;
  let passScore;

  for (let run = 1; run <= requestedRuns; run += 1) {
    attemptedRuns += 1;
    const startedAt = performance.now();
    let response;
    try {
      response = await fetch(`${baseUrl}/api/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testCase.request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      caseTransportOrParseFailure = true;
      emit({
        type: "review-eval-run",
        caseId: testCase.id,
        inputKind: testCase.inputKind,
        language: testCase.language,
        run,
        modelIdentifier,
        requestParameters: REVIEW_EVALUATION_REQUEST_PARAMETERS,
        latencyMs: Math.round(performance.now() - startedAt),
        httpStatus: null,
        validationOutcome: "failed",
        errorCode: safeFetchError(error),
      });
      continue;
    }

    let body;
    try {
      body = await response.json();
    } catch {
      caseTransportOrParseFailure = true;
      emit({
        type: "review-eval-run",
        caseId: testCase.id,
        inputKind: testCase.inputKind,
        language: testCase.language,
        run,
        modelIdentifier,
        requestParameters: REVIEW_EVALUATION_REQUEST_PARAMETERS,
        latencyMs: Math.round(performance.now() - startedAt),
        httpStatus: response.status,
        validationOutcome: "failed",
        parseError: "INVALID_JSON_RESPONSE",
      });
      continue;
    }

    if (!response.ok) {
      caseTransportOrParseFailure = true;
      emit({
        type: "review-eval-run",
        caseId: testCase.id,
        inputKind: testCase.inputKind,
        language: testCase.language,
        run,
        modelIdentifier,
        requestParameters: REVIEW_EVALUATION_REQUEST_PARAMETERS,
        latencyMs: Math.round(performance.now() - startedAt),
        httpStatus: response.status,
        validationOutcome: "failed",
        errorCode: isRecord(body?.error) && typeof body.error.code === "string"
          ? body.error.code
          : "HTTP_ERROR",
      });
      continue;
    }

    if (!isRecord(body) || !isReviewResultShape(body.review)) {
      caseTransportOrParseFailure = true;
      emit({
        type: "review-eval-run",
        caseId: testCase.id,
        inputKind: testCase.inputKind,
        language: testCase.language,
        run,
        modelIdentifier,
        requestParameters: REVIEW_EVALUATION_REQUEST_PARAMETERS,
        latencyMs: Math.round(performance.now() - startedAt),
        httpStatus: response.status,
        validationOutcome: "failed",
        parseError: "INVALID_REVIEW_RESPONSE_SHAPE",
      });
      continue;
    }

    successfulApiRuns += 1;
    successfulReviews.push(body.review);
    if (typeof body.passScore === "number") passScore ??= body.passScore;
    const validation = evaluateReviewResult(testCase, body.review, body.passScore);
    emit({
      type: "review-eval-run",
      caseId: testCase.id,
      inputKind: testCase.inputKind,
      language: testCase.language,
      run,
      modelIdentifier,
      requestParameters: REVIEW_EVALUATION_REQUEST_PARAMETERS,
      latencyMs: Math.round(performance.now() - startedAt),
      httpStatus: response.status,
      validationOutcome: validation.passed ? "passed" : "failed",
      failures: validation.failures,
      scores: scoreRecord(body.review),
      weightedScore: body.review.weightedScore,
      finalScore: body.review.overallScore,
      appliedScoreCap: body.review.appliedScoreCap,
      readinessBand: body.review.readinessBand,
      decision: body.review.decision,
      passScore: typeof body.passScore === "number" ? body.passScore : null,
    });
  }

  const runEvaluation = evaluateReviewRuns(
    testCase,
    successfulReviews,
    requestedRuns,
    passScore,
  );
  const casePassed = runEvaluation.passed && !caseTransportOrParseFailure;
  if (!casePassed) failedCases += 1;
  if (runEvaluation.medianOverallScore !== null) {
    medianScoresByCase[testCase.id] = runEvaluation.medianOverallScore;
  }
  emit({
    type: "review-eval-case-summary",
    caseId: testCase.id,
    passed: casePassed,
    successfulRuns: successfulReviews.length,
    expectedRuns: requestedRuns,
    expectedReadinessBands:
      testCase.expected.allowedReadinessBands ?? [testCase.expected.readinessBand],
    expectedOverallScoreRange: testCase.expected.overallScoreRange,
    medianOverallScore: runEvaluation.medianOverallScore,
    overallRunSpread: runEvaluation.overallSpread,
    categoryRunSpreads: runEvaluation.categorySpreads,
    failures: runEvaluation.failures,
  });
}

const selectedComparisons = reviewEvaluationComparisons.filter(
  ({ higherCaseId, lowerCaseId }) =>
    selectedCaseIds.has(higherCaseId) && selectedCaseIds.has(lowerCaseId),
);
let comparisonPassed = true;
if (selectedComparisons.length > 0) {
  const comparisonEvaluation = evaluateReviewComparisons(
    medianScoresByCase,
    selectedComparisons,
  );
  comparisonPassed = comparisonEvaluation.passed;
  emit({
    type: "review-eval-comparison-summary",
    passed: comparisonEvaluation.passed,
    comparisons: selectedComparisons.map(({ id, higherCaseId, lowerCaseId, minimumMedianGap }) => ({
      id,
      higherMedian: medianScoresByCase[higherCaseId] ?? null,
      lowerMedian: medianScoresByCase[lowerCaseId] ?? null,
      minimumMedianGap,
    })),
    failures: comparisonEvaluation.failures,
  });
} else {
  emit({
    type: "review-eval-comparison-summary",
    passed: true,
    skipped: true,
    reason: "No complete strong-versus-poor comparison pair was selected.",
  });
}

const passed = failedCases === 0 && comparisonPassed;
emit({
  type: "review-eval-summary",
  passed,
  selectedCases: selectedCases.length,
  passedCases: selectedCases.length - failedCases,
  failedCases,
  attemptedRuns,
  successfulApiRuns,
  modelIdentifier,
  requestParameters: REVIEW_EVALUATION_REQUEST_PARAMETERS,
});

if (!passed) process.exitCode = 1;
