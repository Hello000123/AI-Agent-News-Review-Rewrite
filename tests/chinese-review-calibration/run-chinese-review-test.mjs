#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
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

export const TEST_MODEL_OPTIONS = Object.freeze([
  { id: "grok-4.5", label: "Grok 4.5", recommended: true },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", recommended: false },
]);

const testModelIds = new Set(TEST_MODEL_OPTIONS.map(({ id }) => id));
const defaultTestModel = TEST_MODEL_OPTIONS[0].id;

const REVIEWER_SOURCE_FILES = Object.freeze([
  "app/api/review/route.ts",
  "lib/server/agents/review-agent.ts",
  "lib/server/agents/prompts.ts",
  "lib/server/agents/time-context.ts",
  "lib/server/agents/workflow.ts",
  "lib/server/agents/model-client.ts",
  "lib/server/agents/grok-client.ts",
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

function supportedModel(value) {
  const model = value?.trim() || "";
  return testModelIds.has(model) ? model : "";
}

function requireSupportedModel(value, source) {
  const model = supportedModel(value);
  if (model) return model;
  throw new Error(
    `${source} must be one of: ${TEST_MODEL_OPTIONS.map(({ id }) => id).join(", ")}.`,
  );
}

export function modelFromPromptChoice(choice, defaultModel = defaultTestModel) {
  const normalizedChoice = choice.trim().toLocaleLowerCase();
  if (!normalizedChoice) return supportedModel(defaultModel) || defaultTestModel;
  const numericIndex = Number(normalizedChoice);
  if (Number.isInteger(numericIndex) && numericIndex >= 1 && numericIndex <= TEST_MODEL_OPTIONS.length) {
    return TEST_MODEL_OPTIONS[numericIndex - 1].id;
  }
  return supportedModel(normalizedChoice);
}

export async function promptForTestModel(
  defaultModel = defaultTestModel,
  { input = process.stdin, output = process.stdout } = {},
) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      "Choose a test model with --model grok-4.5 or --model deepseek-v4-pro when running non-interactively.",
    );
  }

  const selectedDefault = supportedModel(defaultModel) || defaultTestModel;
  const defaultNumber = TEST_MODEL_OPTIONS.findIndex(({ id }) => id === selectedDefault) + 1;
  const menu = TEST_MODEL_OPTIONS.map(
    ({ id, label, recommended }, index) =>
      `  ${index + 1}) ${label} (${id})${recommended ? " - recommended" : ""}`,
  ).join("\n");
  output.write(`Choose the AI model for this calibration test:\n${menu}\n`);

  const readline = createInterface({ input, output });
  try {
    while (true) {
      const answer = await readline.question(`Select 1 or 2 [${defaultNumber}]: `);
      const model = modelFromPromptChoice(answer, selectedDefault);
      if (model) return model;
      output.write("Invalid choice. Enter 1, 2, grok-4.5, or deepseek-v4-pro.\n");
    }
  } finally {
    readline.close();
  }
}

function readNonSecretProjectEnv(text) {
  const allowed = new Set([
    "AI_MODEL",
    "XAI_MODEL",
    "XAI_TIMEOUT_MS",
    "DEEPSEEK_TIMEOUT_MS",
    "REVIEW_PASS_SCORE",
    "XAI_STREAM",
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
    configured_model:
      process.env.AI_MODEL ||
      localEnv.AI_MODEL ||
      process.env.XAI_MODEL ||
      localEnv.XAI_MODEL ||
      "",
    review_pass_score: process.env.REVIEW_PASS_SCORE || localEnv.REVIEW_PASS_SCORE || "",
    xai_stream_mode: process.env.XAI_STREAM || localEnv.XAI_STREAM || "",
    deepseek_stream_mode:
      process.env.DEEPSEEK_STREAM ||
      localEnv.DEEPSEEK_STREAM ||
      "",
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
  --model MODEL           Use grok-4.5 or deepseek-v4-pro without an interactive prompt
  --model-name MODEL      Backward-compatible alias for --model
  --dataset PATH          Reusable dataset CSV path
  --allow-dataset-quality-warnings
                          Permit duplicate/similar/language-quality warnings; structural validation stays strict
                          (automatically enabled for the bundled default dataset)
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
  const configuredProviderTimeout = Math.max(
    Number(process.env.XAI_TIMEOUT_MS || localEnv.XAI_TIMEOUT_MS || 600_000),
    Number(
      process.env.DEEPSEEK_TIMEOUT_MS ||
      localEnv.DEEPSEEK_TIMEOUT_MS ||
      600_000
    ),
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
    modelName: process.env.EVAL_MODEL?.trim() || "",
    modelWasExplicit: Boolean(process.env.EVAL_MODEL?.trim()),
    defaultModel:
      supportedModel(process.env.AI_MODEL) ||
      supportedModel(localEnv.AI_MODEL) ||
      supportedModel(process.env.XAI_MODEL) ||
      supportedModel(localEnv.XAI_MODEL) ||
      defaultTestModel,
    datasetPath: path.join(scriptDirectory, "chinese_review_drafts_from_txt.csv"),
    allowDatasetQualityWarnings: false,
    outputDirectory: scriptDirectory,
    smoke: false,
    dryRun: false,
    reportOnly: false,
    force: false,
    help: false,
  };
  let datasetWasExplicit = false;

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
      case "--model":
        options.modelName = requireSupportedModel(optionValue(argumentsList, index, argument), argument);
        options.modelWasExplicit = true;
        index += 1;
        break;
      case "--dataset":
        options.datasetPath = path.resolve(optionValue(argumentsList, index, argument));
        datasetWasExplicit = true;
        index += 1;
        break;
      case "--allow-dataset-quality-warnings":
        options.allowDatasetQualityWarnings = true;
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

  if (!datasetWasExplicit) {
    options.allowDatasetQualityWarnings = true;
  }

  if (options.modelWasExplicit) {
    options.modelName = requireSupportedModel(
      options.modelName,
      process.env.EVAL_MODEL?.trim() && !argumentsList.includes("--model") && !argumentsList.includes("--model-name")
        ? "EVAL_MODEL"
        : "--model",
    );
  }
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  options.datasetPath = path.resolve(options.datasetPath);
  options.outputDirectory = path.resolve(options.outputDirectory);
  options.localEnv = localEnv;
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

  const noRequestMode = options.dryRun || options.reportOnly;
  options.modelName = options.modelWasExplicit
    ? options.modelName
    : noRequestMode
      ? options.defaultModel
      : await promptForTestModel(options.defaultModel);
  options.reviewerSha256 = await calculateReviewerSha256(
    options.modelName,
    options.baseUrl,
    options.localEnv,
  );

  const resultsPath = path.join(options.outputDirectory, "chinese_review_results.csv");
  const rawLogPath = path.join(options.outputDirectory, "chinese_review_responses.jsonl");
  const workbookPath = path.join(options.outputDirectory, "chinese_review_test_report.xlsx");
  const previewDirectory = process.env.CHINESE_REVIEW_QA_PREVIEW_DIR?.trim() || "";

  const { rows: dataset, warnings } = await loadDataset(options.datasetPath, {
    allowQualityWarnings: options.allowDatasetQualityWarnings,
  });
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
        modelId: options.modelName,
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
