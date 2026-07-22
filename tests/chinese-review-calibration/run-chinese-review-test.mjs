#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildXlsxReport } from "./build-xlsx-report.mjs";
import {
  analyzeResults,
  buildTasks,
  datasetSha256,
  formatProgress,
  loadDataset,
  loadResults,
  reconcileResults,
  resultKey,
  runCategoryWorkers,
  writeResultsCsv,
} from "./review-test-lib.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..", "..");

const REVIEWER_SOURCE_FILES = Object.freeze([
  "app/api/review/route.ts",
  "lib/server/agents/review-agent.ts",
  "lib/server/agents/prompts.ts",
  "lib/server/agents/time-context.ts",
  "lib/server/agents/workflow.ts",
  "lib/server/agents/deepseek-client.ts",
  "lib/server/config.ts",
  "lib/server/http.ts",
  "lib/server/sources/source-context.ts",
  "lib/shared/contracts.ts",
]);

function positiveInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function optionValue(argumentsList, index, name) {
  if (index + 1 >= argumentsList.length || argumentsList[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return argumentsList[index + 1];
}

function readNonSecretProjectEnv(text) {
  const allowed = new Set([
    "DEEPSEEK_MODEL",
    "DEEPSEEK_TIMEOUT_MS",
    "REVIEW_PASS_SCORE",
    "DEEPSEEK_STREAM",
  ]);
  const values = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    if (!allowed.has(key)) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function projectEnvironment() {
  try {
    const text = await fs.readFile(path.join(projectRoot, ".env.local"), "utf8");
    return readNonSecretProjectEnv(text);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function beforeMarker(text, marker) {
  const index = text.indexOf(marker);
  return index === -1 ? text : text.slice(0, index);
}

function betweenMarkers(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return text;
  const end = text.indexOf(endMarker, start + startMarker.length);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

function reviewerRelevantSource(relativePath, text) {
  if (relativePath.endsWith("/prompts.ts")) {
    return beforeMarker(text, "export const REWRITE_SYSTEM_PROMPT");
  }
  if (relativePath.endsWith("/workflow.ts")) {
    return beforeMarker(text, "export async function rewriteWithFeedback");
  }
  if (relativePath.endsWith("/contracts.ts")) {
    const reviewContracts = beforeMarker(text, "export const rewriteLengthOptionSchema")
      .replace(/^export const MAX_REWRITE_[^\r\n]+(?:\r?\n)?/gmu, "");
    const reviewApiContract = betweenMarkers(
      text,
      "export const reviewApiResponseSchema",
      "export const quotationIssueKindSchema",
    );
    return `${reviewContracts}\n${reviewApiContract}`;
  }
  return text;
}

async function calculateReviewerSha256(modelName, baseUrl, localEnv) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    model_name: modelName,
    base_url: baseUrl,
    configured_model: process.env.DEEPSEEK_MODEL || localEnv.DEEPSEEK_MODEL || "",
    review_pass_score: process.env.REVIEW_PASS_SCORE || localEnv.REVIEW_PASS_SCORE || "",
    stream_mode: process.env.DEEPSEEK_STREAM || localEnv.DEEPSEEK_STREAM || "",
  }));

  for (const relativePath of REVIEWER_SOURCE_FILES) {
    const absolutePath = path.join(projectRoot, ...relativePath.split("/"));
    let source;
    try {
      source = await fs.readFile(absolutePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      source = `[missing:${relativePath}]`;
    }
    const relevantSource = reviewerRelevantSource(relativePath, source);
    hash.update(`\n${relativePath}\n${relevantSource.length}\n${relevantSource}`);
  }

  return hash.digest("hex");
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("--base-url must be an http(s) URL without embedded credentials.");
  }
  return url.toString().replace(/\/+$/u, "");
}

function helpText() {
  return `Traditional Chinese Review Agent calibration harness

Usage:
  node tests/chinese-review-calibration/run-chinese-review-test.mjs [options]

Options:
  --base-url URL          Running application URL (default http://127.0.0.1:3000)
  --concurrency N         Maximum active review requests, 1-5 (default 5)
  --retries N             Retries after the first attempt, 0-10 (default 2)
  --backoff-ms N          Initial exponential-backoff delay, 0-60000 (default 1000)
  --timeout-ms N          Per local endpoint request timeout, 1000-900000
  --repeats N             Runs per draft, 1-10 (default 1)
  --model-name NAME       Non-secret model label recorded in results
  --dataset PATH          Reusable dataset CSV path
  --output-dir PATH       Results/report directory (default: this script directory)
  --smoke                 Select the first draft in each category (five requests)
  --dry-run               Validate inputs and build reports without any request
  --report-only           Rebuild the workbook from saved CSV results only
  --force                 Retest selected successful drafts and replace their CSV rows
  --help                  Show this help
`;
}

async function parseOptions(argumentsList) {
  const localEnv = await projectEnvironment();
  const configuredProviderTimeout = Number(
    process.env.DEEPSEEK_TIMEOUT_MS || localEnv.DEEPSEEK_TIMEOUT_MS || 600_000,
  );
  const fallbackTimeout = Number.isFinite(configuredProviderTimeout)
    ? Math.min(900_000, Math.max(1_000, configuredProviderTimeout + 30_000))
    : 630_000;
  const options = {
    baseUrl: process.env.REVIEW_EVAL_BASE_URL || process.env.LIVE_EVAL_BASE_URL || "http://127.0.0.1:3000",
    concurrency: 5,
    retries: 2,
    backoffMs: 1_000,
    timeoutMs: Number(process.env.REVIEW_EVAL_TIMEOUT_MS || fallbackTimeout),
    repeats: 1,
    modelName:
      process.env.EVAL_MODEL ||
      process.env.DEEPSEEK_MODEL ||
      localEnv.DEEPSEEK_MODEL ||
      "server-configured-model",
    datasetPath: path.join(scriptDirectory, "chinese_review_drafts.csv"),
    outputDirectory: scriptDirectory,
    smoke: false,
    dryRun: false,
    reportOnly: false,
    force: false,
    help: false,
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    switch (argument) {
      case "--base-url":
        options.baseUrl = optionValue(argumentsList, index, argument);
        index += 1;
        break;
      case "--concurrency":
        options.concurrency = positiveInteger(optionValue(argumentsList, index, argument), argument, 1, 5);
        index += 1;
        break;
      case "--retries":
        options.retries = positiveInteger(optionValue(argumentsList, index, argument), argument, 0, 10);
        index += 1;
        break;
      case "--backoff-ms":
        options.backoffMs = positiveInteger(optionValue(argumentsList, index, argument), argument, 0, 60_000);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = positiveInteger(optionValue(argumentsList, index, argument), argument, 1_000, 900_000);
        index += 1;
        break;
      case "--repeats":
        options.repeats = positiveInteger(optionValue(argumentsList, index, argument), argument, 1, 10);
        index += 1;
        break;
      case "--model-name":
        options.modelName = optionValue(argumentsList, index, argument).trim();
        index += 1;
        break;
      case "--dataset":
        options.datasetPath = path.resolve(optionValue(argumentsList, index, argument));
        index += 1;
        break;
      case "--output-dir":
        options.outputDirectory = path.resolve(optionValue(argumentsList, index, argument));
        index += 1;
        break;
      case "--smoke":
        options.smoke = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--report-only":
        options.reportOnly = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!options.modelName || options.modelName.length > 120) {
    throw new Error("--model-name must contain 1-120 characters.");
  }
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  options.datasetPath = path.resolve(options.datasetPath);
  options.outputDirectory = path.resolve(options.outputDirectory);
  options.reviewerSha256 = await calculateReviewerSha256(options.modelName, options.baseUrl, localEnv);
  return options;
}

function staleReasonCounts(staleResults) {
  const counts = {};
  for (const { staleReasons } of staleResults) {
    for (const reason of staleReasons) counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

async function appendRunRecord(
  rawLogPath,
  options,
  datasetCount,
  taskCount,
  recordType,
  currentDatasetSha256,
  staleResults,
) {
  await fs.mkdir(path.dirname(rawLogPath), { recursive: true });
  await fs.appendFile(
    rawLogPath,
    `${JSON.stringify({
      schema_version: 1,
      record_type: recordType,
      timestamp: new Date().toISOString(),
      dataset_count: datasetCount,
      selected_test_count: taskCount,
      repeats: options.repeats,
      concurrency: options.concurrency,
      retry_limit: options.retries,
      backoff_ms: options.backoffMs,
      timeout_ms: options.timeoutMs,
      smoke: options.smoke,
      force: options.force,
      model_name: options.modelName,
      dataset_sha256: currentDatasetSha256,
      reviewer_sha256: options.reviewerSha256,
      stale_result_count: staleResults.length,
      stale_reason_counts: staleReasonCounts(staleResults),
    })}\n`,
    "utf8",
  );
}

async function appendStaleResultRecords(rawLogPath, staleResults) {
  if (staleResults.length === 0) return;
  await fs.mkdir(path.dirname(rawLogPath), { recursive: true });
  const archivedAt = new Date().toISOString();
  const records = staleResults.map(({ result, staleReasons }) => JSON.stringify({
    schema_version: 1,
    record_type: "stale_result",
    archived_at: archivedAt,
    stale_reasons: staleReasons,
    result,
  }));
  await fs.appendFile(rawLogPath, `${records.join("\n")}\n`, "utf8");
}

function createProgressPrinter() {
  let renderedLines = 0;
  return (snapshot) => {
    const output = formatProgress(snapshot);
    if (process.stdout.isTTY && renderedLines > 0) {
      process.stdout.write(`\u001B[${renderedLines}F\u001B[0J`);
    }
    process.stdout.write(`${output}\n`);
    renderedLines = output.split("\n").length;
  };
}

function selectedResultErrors(tasks, results) {
  const keys = new Set(tasks.map(resultKey));
  return results.filter((result) => keys.has(resultKey(result)) && result.test_status === "Error");
}

export async function main(argumentsList = process.argv.slice(2)) {
  const options = await parseOptions(argumentsList);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }

  const resultsPath = path.join(options.outputDirectory, "chinese_review_results.csv");
  const rawLogPath = path.join(options.outputDirectory, "chinese_review_responses.jsonl");
  const workbookPath = path.join(options.outputDirectory, "chinese_review_test_report.xlsx");
  const previewDirectory = process.env.CHINESE_REVIEW_QA_PREVIEW_DIR?.trim() || "";

  const { rows: dataset, warnings } = await loadDataset(options.datasetPath);
  const tasks = buildTasks(dataset, { repeats: options.repeats, smoke: options.smoke });
  const currentDatasetSha256 = datasetSha256(dataset);
  const loadedResults = await loadResults(resultsPath);
  const reconciliation = reconcileResults(dataset, loadedResults, options.reviewerSha256);
  let results = reconciliation.currentResults;

  process.stdout.write(
    `Dataset valid: ${dataset.length} drafts; selected tests: ${tasks.length}; model label: ${options.modelName}; dataset ${currentDatasetSha256.slice(0, 12)}; reviewer ${options.reviewerSha256.slice(0, 12)}.\n`,
  );
  if (reconciliation.staleResults.length > 0) {
    const reasonText = Object.entries(staleReasonCounts(reconciliation.staleResults))
      .map(([reason, count]) => `${reason}: ${count}`)
      .join(", ");
    process.stdout.write(
      `Ignored ${reconciliation.staleResults.length} stale result row(s) (${reasonText}). Historical responses remain in the append-only JSONL log.\n`,
    );
  }
  if (warnings.length > 0) {
    process.stdout.write(`Dataset similarity warnings: ${warnings.length}. Review with --dry-run output if drafts change.\n`);
  }

  const noRequestMode = options.dryRun || options.reportOnly;
  await appendRunRecord(
    rawLogPath,
    options,
    dataset.length,
    tasks.length,
    options.dryRun ? "dry_run" : options.reportOnly ? "report_only" : "test_run",
    currentDatasetSha256,
    reconciliation.staleResults,
  );
  await appendStaleResultRecords(rawLogPath, reconciliation.staleResults);
  await writeResultsCsv(resultsPath, results);

  if (!noRequestMode) {
    results = await runCategoryWorkers({
      tasks,
      existingResults: results,
      resultsPath,
      requestOptions: {
        baseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs,
        retryLimit: options.retries,
        backoffMs: options.backoffMs,
        modelName: options.modelName,
        reviewerSha256: options.reviewerSha256,
        rawLogPath,
      },
      concurrency: options.concurrency,
      force: options.force,
      onProgress: createProgressPrinter(),
    });
  } else {
    process.stdout.write(
      `${options.dryRun ? "Dry run" : "Report-only run"}: no Review Agent or AI request was made.\n`,
    );
  }

  const analysis = analyzeResults(dataset, results);
  const reportResult = await buildXlsxReport({
    dataset,
    results,
    analysis,
    outputPath: workbookPath,
    runConfig: {
      modelName: options.modelName,
      repeats: options.repeats,
      plannedTests: tasks.length,
      mode: options.dryRun ? "dry-run" : options.reportOnly ? "report-only" : options.smoke ? "smoke" : "live",
    },
    previewDirectory,
  });

  process.stdout.write(
    [
      `Results CSV: ${resultsPath}`,
      `Raw response log: ${rawLogPath}`,
      `Excel report: ${reportResult.outputPath}`,
      `Successful tests recorded: ${analysis.successful_tests}`,
      `Failed tests recorded: ${analysis.failed_tests}`,
      `Draft classification accuracy: ${analysis.draft_classification_accuracy === null ? "n/a" : `${(analysis.draft_classification_accuracy * 100).toFixed(1)}%`}`,
    ].join("\n") + "\n",
  );

  const selectedErrors = selectedResultErrors(tasks, results);
  return selectedErrors.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
      setTimeout(() => process.exit(exitCode), 0);
    })
    .catch((error) => {
      process.stderr.write(`Chinese review test failed: ${error.stack || error.message}\n`);
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 0);
    });
}
