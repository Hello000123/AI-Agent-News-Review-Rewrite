import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CATEGORY_CONFIG,
  PIPE_DATASET_HEADERS,
  RESULT_HEADERS,
  analyzeResults,
  authenticateBenchmarkSession,
  buildTasks,
  csvEscape,
  draftSha256,
  formatProgress,
  loadDataset,
  loadResults,
  parseCsv,
  parsePipeDataset,
  predictCategory,
  rangeDistance,
  reconcileResults,
  reviewTask,
  runCategoryWorkers,
  serializeCsv,
  validateReviewApiResponse,
} from "./review-test-lib.mjs";
import { modelFromPromptChoice } from "./run-chinese-review-test.mjs";

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

test("pipe-delimited TXT rows gain category score ranges and preserve pipes in draft text", () => {
  const input = [
    `\uFEFF${PIPE_DATASET_HEADERS.join("|")}`,
    "001|ZH-EXCELLENT-001|001|Excellent|港聞草稿保留正文內的 | 符號。",
  ].join("\r\n");
  assert.deepEqual(parsePipeDataset(input), [{
    global_order: "001",
    draft_id: "ZH-EXCELLENT-001",
    scenario_id: "001",
    category: "Excellent",
    expected_min: 85,
    expected_max: 100,
    draft_text: "港聞草稿保留正文內的 | 符號。",
  }]);
  assert.throws(
    () => parsePipeDataset("global_order|draft_id\n001|ZH-EXCELLENT-001"),
    /Pipe dataset (?:line 1|headers)/u,
  );
});

test("interactive model choices resolve only to the two supported API model IDs", () => {
  assert.equal(modelFromPromptChoice("", "deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(modelFromPromptChoice("1"), "grok-4.5");
  assert.equal(modelFromPromptChoice("2"), "deepseek-v4-pro");
  assert.equal(modelFromPromptChoice("grok-4.5"), "grok-4.5");
  assert.equal(modelFromPromptChoice("unsupported-model"), "");
});

test("the reusable completed dataset loads and validates", async () => {
  const datasetPath = new URL("./chinese_review_drafts.csv", import.meta.url);
  const { rows, warnings } = await loadDataset(datasetPath, {
    allowQualityWarnings: true,
  });
  assert.equal(rows.length, 150);
  assert.equal(warnings.length, 1);
  assert.equal(rows[0].global_order, "001");
  assert.equal(rows.at(-1).global_order, "150");
  assert.equal(rows.filter((row) => row.category === "Good").length, 30);
  assert.ok(
    rows
      .filter((row) => row.category === "Good")
      .every((row) => row.draft_text.length > 0),
  );
});

test("the converted user TXT dataset loads and validates", async () => {
  const datasetPath = new URL("./chinese_review_drafts_from_txt.csv", import.meta.url);
  const { rows, warnings } = await loadDataset(datasetPath, { allowQualityWarnings: true });
  assert.equal(rows.length, 150);
  assert.equal(rows[0].draft_id, "ZH-EXCELLENT-001");
  assert.equal(rows.at(-1).draft_id, "ZH-EXTREMELY-BAD-030");
  assert.ok(warnings.length > 0);
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
      JSON.stringify({ error: { code: "XAI_AUTH_ERROR", message: "Rejected.", retryable: false } }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    ),
    sleepImpl: async () => {},
  });
  assert.equal(result.test_status, "Error");
  assert.equal(result.actual_overall_score, "");
  assert.notEqual(result.actual_overall_score, 0);
  assert.equal(result.error_code, "XAI_AUTH_ERROR");
  assert.equal(result.retry_count, 0);
  assert.equal(result.draft_sha256, draftSha256(task));
  const logRecords = (await fs.readFile(path.join(temporaryDirectory, "responses.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(logRecords.length, 1);
  assert.equal(logRecords[0].response.error.code, "XAI_AUTH_ERROR");
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test("the selected model ID is sent to the production review route", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "chinese-review-model-"));
  let requestBody;
  const task = { ...makeDrafts(1)[0], repeat_number: 1 };
  const result = await reviewTask(task, {
    baseUrl: "http://127.0.0.1:3999",
    timeoutMs: 5_000,
    retryLimit: 0,
    backoffMs: 0,
    modelName: "DeepSeek V4 Pro",
    modelId: "deepseek-v4-pro",
    rawLogPath: path.join(temporaryDirectory, "responses.jsonl"),
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify(reviewResponse(90)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal(requestBody.model, "deepseek-v4-pro");
  assert.equal(requestBody.sourceUrl, "");
  assert.equal(result.model_name, "DeepSeek V4 Pro");
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test("benchmark authentication reuses login cookies and CSRF without logging secrets", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "chinese-review-auth-"));
  const rawLogPath = path.join(temporaryDirectory, "responses.jsonl");
  const password = `${randomBytes(24).toString("base64url")}Aa1!`;
  const sessionToken = randomBytes(24).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  let loginRequest;
  const authentication = await authenticateBenchmarkSession({
    baseUrl: "http://127.0.0.1:3999",
    email: "benchmark@example.test",
    password,
    timeoutMs: 5_000,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/auth/login/challenge")) {
        return new Response(
          JSON.stringify({
            derivation: {
              algorithm: "pbkdf2-sha256",
              salt: Buffer.alloc(16).toString("base64url"),
              iterations: 100_000,
              keyLength: 32,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      loginRequest = options;
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append(
        "Set-Cookie",
        `pressready_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`,
      );
      headers.append(
        "Set-Cookie",
        `pressready_csrf=${csrfToken}; Path=/; SameSite=Strict`,
      );
      return new Response(
        JSON.stringify({ user: { role: "client" }, redirectTo: "/" }),
        { status: 200, headers },
      );
    },
  });
  assert.equal(loginRequest.headers.Origin, "http://127.0.0.1:3999");
  const loginBody = JSON.parse(loginRequest.body);
  assert.deepEqual(
    { email: loginBody.email, password: loginBody.password },
    {
    email: "benchmark@example.test",
    password,
    },
  );
  assert.match(loginBody.passwordProof, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(authentication.csrfToken, csrfToken);
  assert.ok(authentication.cookieHeader.includes(`pressready_session=${sessionToken}`));
  assert.ok(authentication.cookieHeader.includes(`pressready_csrf=${csrfToken}`));

  const task = { ...makeDrafts(1)[0], repeat_number: 1 };
  const result = await reviewTask(task, {
    baseUrl: "http://127.0.0.1:3999",
    timeoutMs: 5_000,
    retryLimit: 0,
    backoffMs: 0,
    modelName: "grok-4.5",
    rawLogPath,
    authentication,
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Origin, "http://127.0.0.1:3999");
      assert.ok(options.headers.Cookie.includes(`pressready_session=${sessionToken}`));
      assert.equal(options.headers["X-CSRF-Token"], csrfToken);
      return new Response(JSON.stringify(reviewResponse(90)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal(result.test_status, "Success");
  const rawLog = await fs.readFile(rawLogPath, "utf8");
  assert.ok(!rawLog.includes(sessionToken));
  assert.ok(!rawLog.includes(csrfToken));
  assert.ok(!rawLog.includes(password));
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
        JSON.stringify({ error: { code: "XAI_RATE_LIMIT", message: "Temporary.", retryable: true } }),
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
