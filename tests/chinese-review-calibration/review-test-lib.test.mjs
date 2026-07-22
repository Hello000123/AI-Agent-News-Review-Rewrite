import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CATEGORY_CONFIG,
  RESULT_HEADERS,
  analyzeResults,
  buildTasks,
  csvEscape,
  draftSha256,
  formatProgress,
  loadDataset,
  loadResults,
  parseCsv,
  predictCategory,
  rangeDistance,
  reconcileResults,
  reviewTask,
  runCategoryWorkers,
  serializeCsv,
  validateReviewApiResponse,
} from "./review-test-lib.mjs";

function makeDrafts(perCategory = 2) {
  let globalOrder = 0;
  return CATEGORY_CONFIG.flatMap((category) =>
    Array.from({ length: perCategory }, (_, index) => {
      globalOrder += 1;
      return {
        global_order: String(globalOrder).padStart(3, "0"),
        draft_id: `ZH-${category.idToken}-${String(index + 1).padStart(3, "0")}`,
        scenario_id: String(index + 1).padStart(3, "0"),
        category: category.name,
        expected_min: category.minimum,
        expected_max: category.maximum,
        draft_text: `${category.name} test draft ${index + 1}`,
      };
    }),
  );
}

function reviewResponse(score) {
  return {
    review: {
      factualCompletenessScore: score,
      structureScore: score,
      clarityScore: score,
      languageQualityScore: score,
      professionalismScore: score,
      attributionScore: score,
      weightedScore: score,
      overallScore: score,
      appliedScoreCap: null,
      readinessBand: score >= 90 ? "PUBLICATION_READY" : score >= 75 ? "STRONG_LIMITED_EDITING" : score >= 60 ? "SUBSTANTIAL_REWRITE" : score >= 40 ? "WEAK" : "SEVERELY_DEFICIENT",
      decision: score >= 80 ? "PASS" : "REWRITE_REQUIRED",
      scoreReasons: {},
      readinessRisks: {},
      findings: [],
      strengths: [],
      missingInformation: [],
      recommendations: [],
      scoreCapReasons: [],
    },
    source: { primaryText: "test", userDraft: "test", imageContext: [] },
    passScore: 80,
    message: "test",
  };
}

test("CSV round-trips BOM-safe multiline Traditional Chinese text", () => {
  const rows = [{ id: "001", draft: "標題，含逗號\n\n第二段有「引號」及 \"ASCII quote\"。" }];
  const csv = serializeCsv(["id", "draft"], rows, { bom: true });
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.deepEqual(parseCsv(csv), rows);
  assert.equal(csvEscape("a,b"), '"a,b"');
});

test("the reusable quote-all dataset loads and validates", async () => {
  const datasetPath = new URL("./chinese_review_drafts.csv", import.meta.url);
  const { rows, warnings } = await loadDataset(datasetPath);
  assert.equal(rows.length, 150);
  assert.equal(warnings.length, 0);
  assert.equal(rows[0].global_order, "001");
  assert.equal(rows.at(-1).global_order, "150");
});

test("legacy results load safely with blank fingerprints for one-time invalidation", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "chinese-review-legacy-"));
  const resultsPath = path.join(temporaryDirectory, "legacy-results.csv");
  const legacyHeaders = RESULT_HEADERS.slice(0, -2);
  const legacyRow = Object.fromEntries(legacyHeaders.map((header) => [header, ""]));
  legacyRow.global_order = "001";
  legacyRow.draft_id = "ZH-EXCELLENT-001";
  legacyRow.scenario_id = "001";
  legacyRow.category = "Excellent";
  legacyRow.repeat_number = 1;
  legacyRow.test_status = "Success";
  await fs.writeFile(
    resultsPath,
    serializeCsv(legacyHeaders, [legacyRow], { bom: true }),
    "utf8",
  );
  const [loaded] = await loadResults(resultsPath);
  assert.deepEqual(Object.keys(loaded), RESULT_HEADERS);
  assert.equal(loaded.draft_sha256, "");
  assert.equal(loaded.reviewer_sha256, "");
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test("requested score bands classify inclusive boundary values", () => {
  const expected = new Map([
    [100, "Excellent"], [85, "Excellent"], [84, "Good"], [70, "Good"],
    [69, "Normal"], [50, "Normal"], [49, "Bad"], [30, "Bad"],
    [29, "Extremely Bad"], [0, "Extremely Bad"],
  ]);
  for (const [score, category] of expected) assert.equal(predictCategory(score), category);
  assert.deepEqual(rangeDistance(20, 30, 49), { below: 10, above: 0, distance: 10 });
  assert.deepEqual(rangeDistance(55, 30, 49), { below: 0, above: 6, distance: 6 });
  assert.deepEqual(rangeDistance(40, 30, 49), { below: 0, above: 0, distance: 0 });
});

test("response validation preserves all scores and rejects nonnumeric or out-of-range values", () => {
  const valid = reviewResponse(80);
  assert.equal(validateReviewApiResponse(valid), valid);
  assert.throws(
    () => validateReviewApiResponse({ ...valid, review: { ...valid.review, overallScore: "80" } }),
    /overallScore must be a numeric score/u,
  );
  assert.throws(
    () => validateReviewApiResponse({ ...valid, review: { ...valid.review, structureScore: 101 } }),
    /structureScore must be a numeric score/u,
  );
});

test("an exhausted or non-retryable failure is saved as an error, never score zero", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "chinese-review-error-"));
  const task = { ...makeDrafts(1)[0], repeat_number: 1 };
  const result = await reviewTask(task, {
    baseUrl: "http://127.0.0.1:3999",
    timeoutMs: 5_000,
    retryLimit: 3,
    backoffMs: 0,
    modelName: "mock-model",
    rawLogPath: path.join(temporaryDirectory, "responses.jsonl"),
    fetchImpl: async () => new Response(
      JSON.stringify({ error: { code: "DEEPSEEK_AUTH_ERROR", message: "Rejected.", retryable: false } }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    ),
    sleepImpl: async () => {},
  });
  assert.equal(result.test_status, "Error");
  assert.equal(result.actual_overall_score, "");
  assert.notEqual(result.actual_overall_score, 0);
  assert.equal(result.error_code, "DEEPSEEK_AUTH_ERROR");
  assert.equal(result.retry_count, 0);
  assert.equal(result.draft_sha256, draftSha256(task));
  const logRecords = (await fs.readFile(path.join(temporaryDirectory, "responses.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(logRecords.length, 1);
  assert.equal(logRecords[0].response.error.code, "DEEPSEEK_AUTH_ERROR");
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test("five category workers honor concurrency, ordering, retry, persistence, resume, and force", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "chinese-review-harness-"));
  const resultsPath = path.join(temporaryDirectory, "results.csv");
  const rawLogPath = path.join(temporaryDirectory, "responses.jsonl");
  const drafts = makeDrafts(2);
  const tasks = buildTasks(drafts, { repeats: 1 });
  const scores = new Map([
    ["Excellent", 90], ["Good", 75], ["Normal", 60], ["Bad", 40], ["Extremely Bad", 20],
  ]);
  const attempts = new Map();
  const requestOrder = [];
  let active = 0;
  let maximumActive = 0;
  let requestCount = 0;

  const fetchImpl = async (_url, options) => {
    const { draft } = JSON.parse(options.body);
    requestCount += 1;
    requestOrder.push(draft);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    attempts.set(draft, (attempts.get(draft) ?? 0) + 1);
    if (draft === "Bad test draft 1" && attempts.get(draft) === 1) {
      return new Response(
        JSON.stringify({ error: { code: "DEEPSEEK_RATE_LIMIT", message: "Temporary.", retryable: true } }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    const category = CATEGORY_CONFIG.find(({ name }) => draft.startsWith(name)).name;
    return new Response(JSON.stringify(reviewResponse(scores.get(category))), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const progress = [];
  let results = await runCategoryWorkers({
    tasks,
    existingResults: [],
    resultsPath,
    requestOptions: {
      baseUrl: "http://127.0.0.1:3999",
      timeoutMs: 5_000,
      retryLimit: 1,
      backoffMs: 0,
      modelName: "mock-model",
      reviewerSha256: "reviewer-v1",
      rawLogPath,
      fetchImpl,
      sleepImpl: async () => {},
    },
    concurrency: 3,
    onProgress: async (snapshot) => {
      progress.push(snapshot);
      const savedAtUpdate = await loadResults(resultsPath);
      assert.equal(savedAtUpdate.length, snapshot.completed);
    },
  });

  assert.equal(results.length, 10);
  assert.ok(results.every((result) => result.test_status === "Success"));
  assert.equal(maximumActive, 3);
  assert.equal(requestCount, 11);
  assert.equal(attempts.get("Bad test draft 1"), 2);
  assert.equal(results.find((result) => result.draft_text === "Bad test draft 1"), undefined);
  assert.equal(results.find((result) => result.draft_id === "ZH-BAD-001").retry_count, 1);
  assert.equal(progress.length, 11);
  assert.equal(progress.at(-1).completed, 10);
  assert.equal(progress.at(-1).errors, 0);
  assert.match(formatProgress(progress.at(-1)), /Excellent: 2\/2 completed \(100\.0%\)/u);
  assert.match(formatProgress(progress.at(-1)), /Overall: 10\/10 completed \(100\.0%\)/u);

  for (const { name } of CATEGORY_CONFIG) {
    const first = `${name} test draft 1`;
    const second = `${name} test draft 2`;
    assert.ok(requestOrder.indexOf(first) < requestOrder.indexOf(second));
  }

  const persisted = await loadResults(resultsPath);
  assert.equal(persisted.length, 10);
  assert.deepEqual(Object.keys(persisted[0]), RESULT_HEADERS);
  assert.ok(persisted.every((result) => result.draft_sha256.length === 64));
  assert.ok(persisted.every((result) => result.reviewer_sha256 === "reviewer-v1"));
  assert.equal(reconcileResults(drafts, persisted, "reviewer-v1").staleResults.length, 0);
  const logRecords = (await fs.readFile(rawLogPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(logRecords.length, 11);
  assert.equal(logRecords.filter((record) => record.outcome === "success").length, 10);
  assert.ok(logRecords.every((record) => !("api_key" in record)));

  const beforeResume = requestCount;
  results = await runCategoryWorkers({
    tasks,
    existingResults: persisted,
    resultsPath,
    requestOptions: {
      baseUrl: "http://127.0.0.1:3999",
      timeoutMs: 5_000,
      retryLimit: 1,
      backoffMs: 0,
      modelName: "mock-model",
      reviewerSha256: "reviewer-v1",
      rawLogPath,
      fetchImpl,
      sleepImpl: async () => {},
    },
    concurrency: 5,
  });
  assert.equal(requestCount, beforeResume);
  assert.equal(results.length, 10);

  const changedDrafts = drafts.map((draft, index) => index === 0
    ? { ...draft, draft_text: `${draft.draft_text} changed` }
    : draft);
  const changedTasks = buildTasks(changedDrafts, { repeats: 1 });
  const changedReconciliation = reconcileResults(changedDrafts, results, "reviewer-v1");
  assert.equal(changedReconciliation.currentResults.length, 9);
  assert.equal(changedReconciliation.staleResults.length, 1);
  assert.deepEqual(changedReconciliation.staleResults[0].staleReasons, ["draft_changed"]);

  results = await runCategoryWorkers({
    tasks: changedTasks,
    existingResults: results,
    resultsPath,
    requestOptions: {
      baseUrl: "http://127.0.0.1:3999",
      timeoutMs: 5_000,
      retryLimit: 1,
      backoffMs: 0,
      modelName: "mock-model",
      reviewerSha256: "reviewer-v1",
      rawLogPath,
      fetchImpl,
      sleepImpl: async () => {},
    },
    concurrency: 5,
  });
  assert.equal(requestCount, beforeResume + 1);
  assert.equal(results.find((result) => result.draft_id === changedTasks[0].draft_id).draft_sha256, draftSha256(changedTasks[0]));

  const reviewerReconciliation = reconcileResults(changedDrafts, results, "reviewer-v2");
  assert.equal(reviewerReconciliation.currentResults.length, 0);
  assert.equal(reviewerReconciliation.staleResults.length, 10);
  results = await runCategoryWorkers({
    tasks: changedTasks,
    existingResults: results,
    resultsPath,
    requestOptions: {
      baseUrl: "http://127.0.0.1:3999",
      timeoutMs: 5_000,
      retryLimit: 1,
      backoffMs: 0,
      modelName: "mock-model",
      reviewerSha256: "reviewer-v2",
      rawLogPath,
      fetchImpl,
      sleepImpl: async () => {},
    },
    concurrency: 5,
  });
  assert.equal(requestCount, beforeResume + 11);

  await runCategoryWorkers({
    tasks: changedTasks,
    existingResults: results,
    resultsPath,
    requestOptions: {
      baseUrl: "http://127.0.0.1:3999",
      timeoutMs: 5_000,
      retryLimit: 1,
      backoffMs: 0,
      modelName: "mock-model",
      reviewerSha256: "reviewer-v2",
      rawLogPath,
      fetchImpl,
      sleepImpl: async () => {},
    },
    concurrency: 5,
    force: true,
  });
  assert.equal(requestCount, beforeResume + 21);

  const analysis = analyzeResults(changedDrafts, results);
  assert.equal(analysis.successful_tests, 10);
  assert.equal(analysis.failed_tests, 0);
  assert.equal(analysis.draft_classification_accuracy, 1);

  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});
