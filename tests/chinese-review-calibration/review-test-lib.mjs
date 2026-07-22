import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

export const CATEGORY_CONFIG = Object.freeze([
  { name: "Excellent", idToken: "EXCELLENT", minimum: 85, maximum: 100 },
  { name: "Good", idToken: "GOOD", minimum: 70, maximum: 84 },
  { name: "Normal", idToken: "NORMAL", minimum: 50, maximum: 69 },
  { name: "Bad", idToken: "BAD", minimum: 30, maximum: 49 },
  { name: "Extremely Bad", idToken: "EXTREMELY-BAD", minimum: 0, maximum: 29 },
]);

export const DATASET_HEADERS = Object.freeze([
  "global_order",
  "draft_id",
  "scenario_id",
  "category",
  "expected_min",
  "expected_max",
  "draft_text",
]);

export const RESULT_HEADERS = Object.freeze([
  "global_order",
  "draft_id",
  "scenario_id",
  "category",
  "expected_min",
  "expected_max",
  "repeat_number",
  "actual_overall_score",
  "factual_completeness_score",
  "structure_score",
  "clarity_score",
  "language_quality_score",
  "professionalism_score",
  "attribution_score",
  "weighted_score",
  "applied_score_cap",
  "in_expected_range",
  "distance_from_expected_range",
  "distance_below_expected_range",
  "distance_above_expected_range",
  "predicted_category",
  "category_correct",
  "readiness_band",
  "decision",
  "pass_score",
  "test_status",
  "error_type",
  "error_code",
  "error_message",
  "retry_count",
  "response_time_ms",
  "model_name",
  "test_timestamp",
  "http_status",
  "draft_sha256",
  "reviewer_sha256",
]);

const LEGACY_RESULT_HEADERS = Object.freeze(
  RESULT_HEADERS.filter((header) => !["draft_sha256", "reviewer_sha256"].includes(header)),
);

export const REVIEW_SCORE_FIELDS = Object.freeze([
  ["factualCompletenessScore", "factual_completeness_score"],
  ["structureScore", "structure_score"],
  ["clarityScore", "clarity_score"],
  ["languageQualityScore", "language_quality_score"],
  ["professionalismScore", "professionalism_score"],
  ["attributionScore", "attribution_score"],
  ["weightedScore", "weighted_score"],
  ["overallScore", "actual_overall_score"],
]);

const categoryIndex = new Map(CATEGORY_CONFIG.map((category, index) => [category.name, index]));
const categoryByName = new Map(CATEGORY_CONFIG.map((category) => [category.name, category]));
const transientHttpStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const jsonlWriteQueues = new Map();
const simplifiedOnlyCharacters = new Set(Array.from(
  "这为个们来时后发会学体实国业报据点数处达进选经应总还湾万亿种从将称让现无间门听说创轮录项阶确测划审计调机构资讯华价购规则责车电网务区场线开药卫儿运优并与参广众号",
));

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function draftSha256(draft) {
  return sha256(JSON.stringify(DATASET_HEADERS.map((header) => draft[header] ?? "")));
}

export function datasetSha256(rows) {
  return sha256(rows.map((row) => draftSha256(row)).join("\n"));
}

export function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeCsv(headers, rows, { bom = false } = {}) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }
  return `${bom ? "\uFEFF" : ""}${lines.join("\r\n")}\r\n`;
}

export function parseCsv(input) {
  const text = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      if (field.endsWith("\r")) field = field.slice(0, -1);
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  if (rows.length === 0) return [];

  const headers = rows[0];
  return rows.slice(1).map((values, rowIndex) => {
    if (values.length !== headers.length) {
      throw new Error(
        `CSV row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}.`,
      );
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

function normalizedText(text) {
  return text.normalize("NFKC").toLocaleLowerCase("zh-HK").replace(/[\p{P}\p{S}\s]/gu, "");
}

function ngrams(text, size = 5) {
  const normalized = normalizedText(text);
  const grams = new Set();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
}

function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  let overlap = 0;
  for (const value of left) if (right.has(value)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
}

export function validateDataset(rows) {
  const errors = [];
  const warnings = [];
  const expectedCategories = new Map(CATEGORY_CONFIG.map(({ name }) => [name, 0]));
  const seenOrders = new Set();
  const seenDraftIds = new Set();
  const scenarios = new Map();
  const normalizedDrafts = new Map();

  if (rows.length !== 150) errors.push(`Dataset must contain 150 drafts; found ${rows.length}.`);

  rows.forEach((row, index) => {
    const expectedOrder = String(index + 1).padStart(3, "0");
    if (row.global_order !== expectedOrder) {
      errors.push(`Row ${index + 2}: global_order must be ${expectedOrder}; found ${row.global_order}.`);
    }
    if (!/^\d{3}$/u.test(row.global_order)) {
      errors.push(`Row ${index + 2}: invalid global_order ${row.global_order}.`);
    }
    if (seenOrders.has(row.global_order)) errors.push(`Duplicate global_order ${row.global_order}.`);
    seenOrders.add(row.global_order);

    const category = categoryByName.get(row.category);
    if (!category) {
      errors.push(`Row ${index + 2}: unknown category ${row.category}.`);
    } else {
      expectedCategories.set(category.name, expectedCategories.get(category.name) + 1);
      const expectedId = `ZH-${category.idToken}-${row.scenario_id}`;
      if (row.draft_id !== expectedId) {
        errors.push(`Row ${index + 2}: draft_id must be ${expectedId}; found ${row.draft_id}.`);
      }
      if (Number(row.expected_min) !== category.minimum || Number(row.expected_max) !== category.maximum) {
        errors.push(
          `Row ${index + 2}: expected range for ${category.name} must be ${category.minimum}-${category.maximum}.`,
        );
      }
      const expectedCategoryIndex = Math.floor(index / 30);
      if (CATEGORY_CONFIG[expectedCategoryIndex]?.name !== category.name) {
        errors.push(`Row ${index + 2}: category ordering is not category-major.`);
      }
    }

    if (!/^\d{3}$/u.test(row.scenario_id) || Number(row.scenario_id) < 1 || Number(row.scenario_id) > 30) {
      errors.push(`Row ${index + 2}: invalid scenario_id ${row.scenario_id}.`);
    }
    if (seenDraftIds.has(row.draft_id)) errors.push(`Duplicate draft_id ${row.draft_id}.`);
    seenDraftIds.add(row.draft_id);

    const scenarioCategories = scenarios.get(row.scenario_id) ?? new Set();
    scenarioCategories.add(row.category);
    scenarios.set(row.scenario_id, scenarioCategories);

    const draft = row.draft_text?.trim() ?? "";
    if (!draft) errors.push(`Row ${index + 2}: draft_text is empty.`);
    if (!/\p{Script=Han}/u.test(draft)) errors.push(`Row ${index + 2}: draft has no Chinese text.`);
    if (/\b(?:Excellent|Good|Normal|Bad|Extremely Bad)\b/iu.test(draft)) {
      errors.push(`Row ${index + 2}: draft leaks an English quality category.`);
    }
    if (/(?:expected\s*score|預期分數|85\s*[–-]\s*100|70\s*[–-]\s*84|50\s*[–-]\s*69|30\s*[–-]\s*49|0\s*[–-]\s*29)/iu.test(draft)) {
      errors.push(`Row ${index + 2}: draft leaks an expected score or range.`);
    }
    if (/(?:\[\s*待補\s*\]|\[\s*TBD\s*\]|\bTBD\b|\bXXX\b|Lorem ipsum|<placeholder>)/iu.test(draft)) {
      errors.push(`Row ${index + 2}: draft contains a placeholder marker.`);
    }
    if (/(?:稿件(?:沒有|未有|一下|前後)|資料(?:前後|一處)|另一份表|另一處又|寫得容易|寫法容易|讀落不知|很難記|容易看錯|一開始看不明|沒有時鐘|幾件事一口氣說|之後才提到賽事本身|次序算是這樣安排|優惠先放在公布最前)/u.test(draft)) {
      errors.push(`Row ${index + 2}: draft contains an artificial self-review cue instead of a natural writing defect.`);
    }
    const simplifiedHits = [...new Set(Array.from(draft).filter((character) => simplifiedOnlyCharacters.has(character)))];
    if (simplifiedHits.length > 0) {
      errors.push(`Row ${index + 2}: possible Simplified Chinese characters: ${simplifiedHits.join("")}.`);
    }
    if (/雷射/u.test(draft)) {
      errors.push(`Row ${index + 2}: use Hong Kong wording \"激光\" instead of Taiwan-leaning \"雷射\".`);
    }

    const normalized = normalizedText(draft);
    if (normalizedDrafts.has(normalized)) {
      errors.push(`Rows ${normalizedDrafts.get(normalized)} and ${index + 2} contain duplicate draft text.`);
    } else {
      normalizedDrafts.set(normalized, index + 2);
    }
  });

  for (const { name } of CATEGORY_CONFIG) {
    const count = expectedCategories.get(name);
    if (count !== 30) errors.push(`Category ${name} must contain 30 drafts; found ${count}.`);
  }
  for (let scenario = 1; scenario <= 30; scenario += 1) {
    const id = String(scenario).padStart(3, "0");
    const present = scenarios.get(id) ?? new Set();
    const missing = CATEGORY_CONFIG.map(({ name }) => name).filter((name) => !present.has(name));
    if (missing.length > 0 || present.size !== 5) {
      errors.push(`Scenario ${id} must have one draft in every category; missing: ${missing.join(", ") || "none"}.`);
    }
  }

  const gramSets = rows.map((row) => ngrams(row.draft_text));
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      const similarity = jaccard(gramSets[left], gramSets[right]);
      if (similarity >= 0.92) {
        errors.push(
          `Drafts ${rows[left].draft_id} and ${rows[right].draft_id} are too similar (${(similarity * 100).toFixed(1)}%).`,
        );
      } else if (similarity >= 0.82) {
        warnings.push(
          `Review similarity between ${rows[left].draft_id} and ${rows[right].draft_id}: ${(similarity * 100).toFixed(1)}%.`,
        );
      }
    }
  }

  return { errors, warnings };
}

export async function loadDataset(datasetPath) {
  const buffer = await fs.readFile(datasetPath);
  if (buffer.length < 3 || buffer[0] !== 0xEF || buffer[1] !== 0xBB || buffer[2] !== 0xBF) {
    throw new Error("Dataset CSV must be UTF-8 with BOM.");
  }
  const text = buffer.toString("utf8");
  const parsedRows = parseCsv(text);
  const actualHeaders = parsedRows.length > 0 ? Object.keys(parsedRows[0]) : [];
  if (actualHeaders.join("\u0000") !== DATASET_HEADERS.join("\u0000")) {
    throw new Error(`Dataset headers must be: ${DATASET_HEADERS.join(", ")}.`);
  }
  const rows = parsedRows.map((row) => ({
    ...row,
    expected_min: Number(row.expected_min),
    expected_max: Number(row.expected_max),
  }));
  const validation = validateDataset(rows);
  if (validation.errors.length > 0) {
    throw new Error(`Dataset validation failed:\n- ${validation.errors.join("\n- ")}`);
  }
  return { rows, warnings: validation.warnings };
}

export function predictCategory(score) {
  if (!Number.isFinite(score) || score < 0 || score > 100) return "";
  return CATEGORY_CONFIG.find(({ minimum, maximum }) => score >= minimum && score <= maximum)?.name ?? "";
}

export function rangeDistance(score, minimum, maximum) {
  const below = Math.max(0, minimum - score);
  const above = Math.max(0, score - maximum);
  return { below, above, distance: below + above };
}

export function resultKey(result) {
  return `${result.draft_id}::${Number(result.repeat_number)}`;
}

export function sortResults(results) {
  return [...results].sort((left, right) => {
    const categoryDifference = (categoryIndex.get(left.category) ?? 99) - (categoryIndex.get(right.category) ?? 99);
    if (categoryDifference !== 0) return categoryDifference;
    const orderDifference = Number(left.global_order) - Number(right.global_order);
    if (orderDifference !== 0) return orderDifference;
    return Number(left.repeat_number) - Number(right.repeat_number);
  });
}

function valueForCsv(value) {
  return value === null || value === undefined ? "" : value;
}

export async function writeResultsCsv(resultsPath, results) {
  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  const sorted = sortResults(results);
  const csv = serializeCsv(
    RESULT_HEADERS,
    sorted.map((row) => Object.fromEntries(RESULT_HEADERS.map((header) => [header, valueForCsv(row[header])]))),
    { bom: true },
  );
  const temporaryPath = `${resultsPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, csv, "utf8");
  try {
    await fs.rename(temporaryPath, resultsPath);
  } catch (error) {
    if (!["EEXIST", "EPERM", "EACCES"].includes(error?.code)) throw error;
    await fs.copyFile(temporaryPath, resultsPath);
    await fs.rm(temporaryPath, { force: true });
  }
}

export async function loadResults(resultsPath) {
  try {
    const text = await fs.readFile(resultsPath, "utf8");
    const rows = parseCsv(text);
    if (rows.length === 0) return [];
    const actualHeaders = Object.keys(rows[0]);
    const currentSchema = actualHeaders.join("\u0000") === RESULT_HEADERS.join("\u0000");
    const legacySchema = actualHeaders.join("\u0000") === LEGACY_RESULT_HEADERS.join("\u0000");
    if (!currentSchema && !legacySchema) {
      throw new Error("Existing results CSV has an incompatible header schema.");
    }
    const numericFields = new Set([
      "expected_min", "expected_max", "repeat_number", "actual_overall_score",
      "factual_completeness_score", "structure_score", "clarity_score",
      "language_quality_score", "professionalism_score", "attribution_score",
      "weighted_score", "applied_score_cap", "distance_from_expected_range",
      "distance_below_expected_range", "distance_above_expected_range", "pass_score",
      "retry_count", "response_time_ms", "http_status",
    ]);
    return rows.map((row) => {
      const migrated = legacySchema
        ? { ...row, draft_sha256: "", reviewer_sha256: "" }
        : row;
      return Object.fromEntries(
        Object.entries(migrated).map(([key, value]) => [
          key,
          numericFields.has(key) && value !== "" ? Number(value) : value,
        ]),
      );
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export function reconcileResults(dataset, results, reviewerSha256 = "") {
  const draftFingerprints = new Map(dataset.map((draft) => [draft.draft_id, draftSha256(draft)]));
  const currentResults = [];
  const staleResults = [];

  for (const result of results) {
    const expectedDraftSha256 = draftFingerprints.get(result.draft_id);
    const staleReasons = [];
    if (!expectedDraftSha256) staleReasons.push("draft_removed");
    else if (result.draft_sha256 !== expectedDraftSha256) staleReasons.push("draft_changed");
    if (reviewerSha256 && result.reviewer_sha256 !== reviewerSha256) {
      staleReasons.push("reviewer_changed");
    }

    if (staleReasons.length > 0) staleResults.push({ result, staleReasons });
    else currentResults.push(result);
  }

  return { currentResults: sortResults(currentResults), staleResults };
}

export function validateReviewApiResponse(body) {
  if (!isRecord(body) || !isRecord(body.review)) {
    throw Object.assign(new Error("Response does not contain a review object."), {
      errorType: "Validation",
      errorCode: "INVALID_REVIEW_RESPONSE_SHAPE",
      retryable: true,
    });
  }
  const review = body.review;
  for (const [apiField] of REVIEW_SCORE_FIELDS) {
    const value = review[apiField];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw Object.assign(new Error(`${apiField} must be a numeric score from 0 to 100.`), {
        errorType: "Validation",
        errorCode: "INVALID_SCORE",
        retryable: true,
      });
    }
  }
  if (
    review.appliedScoreCap !== null &&
    (typeof review.appliedScoreCap !== "number" ||
      !Number.isFinite(review.appliedScoreCap) ||
      review.appliedScoreCap < 0 ||
      review.appliedScoreCap > 100)
  ) {
    throw Object.assign(new Error("appliedScoreCap must be null or a numeric score from 0 to 100."), {
      errorType: "Validation",
      errorCode: "INVALID_SCORE_CAP",
      retryable: true,
    });
  }
  if (typeof review.readinessBand !== "string" || typeof review.decision !== "string") {
    throw Object.assign(new Error("Response is missing readinessBand or decision."), {
      errorType: "Validation",
      errorCode: "INVALID_REVIEW_RESPONSE_SHAPE",
      retryable: true,
    });
  }
  if (typeof body.passScore !== "number" || !Number.isFinite(body.passScore) || body.passScore < 0 || body.passScore > 100) {
    throw Object.assign(new Error("passScore must be a numeric score from 0 to 100."), {
      errorType: "Validation",
      errorCode: "INVALID_PASS_SCORE",
      retryable: true,
    });
  }
  return body;
}

function successResult(
  task,
  body,
  retryCount,
  responseTimeMs,
  modelName,
  timestamp,
  httpStatus,
  reviewerSha256,
) {
  const review = body.review;
  const actual = review.overallScore;
  const distance = rangeDistance(actual, task.expected_min, task.expected_max);
  const predicted = predictCategory(actual);
  return {
    global_order: task.global_order,
    draft_id: task.draft_id,
    scenario_id: task.scenario_id,
    category: task.category,
    expected_min: task.expected_min,
    expected_max: task.expected_max,
    repeat_number: task.repeat_number,
    actual_overall_score: actual,
    factual_completeness_score: review.factualCompletenessScore,
    structure_score: review.structureScore,
    clarity_score: review.clarityScore,
    language_quality_score: review.languageQualityScore,
    professionalism_score: review.professionalismScore,
    attribution_score: review.attributionScore,
    weighted_score: review.weightedScore,
    applied_score_cap: review.appliedScoreCap,
    in_expected_range: distance.distance === 0 ? "Yes" : "No",
    distance_from_expected_range: distance.distance,
    distance_below_expected_range: distance.below,
    distance_above_expected_range: distance.above,
    predicted_category: predicted,
    category_correct: predicted === task.category ? "Yes" : "No",
    readiness_band: review.readinessBand,
    decision: review.decision,
    pass_score: body.passScore,
    test_status: "Success",
    error_type: "",
    error_code: "",
    error_message: "",
    retry_count: retryCount,
    response_time_ms: responseTimeMs,
    model_name: modelName,
    test_timestamp: timestamp,
    http_status: httpStatus,
    draft_sha256: draftSha256(task),
    reviewer_sha256: reviewerSha256,
  };
}

function errorResult(task, failure, retryCount, responseTimeMs, modelName, timestamp, reviewerSha256) {
  return {
    global_order: task.global_order,
    draft_id: task.draft_id,
    scenario_id: task.scenario_id,
    category: task.category,
    expected_min: task.expected_min,
    expected_max: task.expected_max,
    repeat_number: task.repeat_number,
    actual_overall_score: "",
    factual_completeness_score: "",
    structure_score: "",
    clarity_score: "",
    language_quality_score: "",
    professionalism_score: "",
    attribution_score: "",
    weighted_score: "",
    applied_score_cap: "",
    in_expected_range: "",
    distance_from_expected_range: "",
    distance_below_expected_range: "",
    distance_above_expected_range: "",
    predicted_category: "",
    category_correct: "",
    readiness_band: "",
    decision: "",
    pass_score: "",
    test_status: "Error",
    error_type: failure.errorType ?? "API",
    error_code: failure.errorCode ?? "UNKNOWN_ERROR",
    error_message: failure.message ?? "Unknown review failure.",
    retry_count: retryCount,
    response_time_ms: responseTimeMs,
    model_name: modelName,
    test_timestamp: timestamp,
    http_status: failure.httpStatus ?? "",
    draft_sha256: draftSha256(task),
    reviewer_sha256: reviewerSha256,
  };
}

async function appendJsonl(logPath, record) {
  const previous = jsonlWriteQueues.get(logPath) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
  });
  jsonlWriteQueues.set(logPath, operation);
  try {
    await operation;
  } finally {
    if (jsonlWriteQueues.get(logPath) === operation) jsonlWriteQueues.delete(logPath);
  }
}

function safeFetchFailure(error) {
  const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
  return {
    errorType: timeout ? "Timeout" : "API",
    errorCode: timeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
    message: timeout ? "The local review request timed out." : "The local Review Agent endpoint could not be reached.",
    retryable: true,
    httpStatus: "",
    diagnostic: { name: error?.name || "Error", message: String(error?.message || "Fetch failed.") },
  };
}

function apiFailure(response, body) {
  const safeError = isRecord(body?.error) ? body.error : {};
  return {
    errorType: "API",
    errorCode: typeof safeError.code === "string" ? safeError.code : `HTTP_${response.status}`,
    message: typeof safeError.message === "string" ? safeError.message : `Review endpoint returned HTTP ${response.status}.`,
    retryable:
      typeof safeError.retryable === "boolean"
        ? safeError.retryable
        : transientHttpStatuses.has(response.status),
    httpStatus: response.status,
  };
}

function parsingFailure(response) {
  return {
    errorType: "Parsing",
    errorCode: "INVALID_JSON_RESPONSE",
    message: "Review endpoint returned invalid JSON.",
    retryable: true,
    httpStatus: response.status,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function reviewTask(task, options) {
  const {
    baseUrl,
    timeoutMs,
    retryLimit,
    backoffMs,
    modelName,
    reviewerSha256 = "",
    rawLogPath,
    fetchImpl = fetch,
    sleepImpl = sleep,
    now = () => new Date(),
  } = options;
  const taskStarted = performance.now();
  let finalFailure;
  let finalRetryCount = 0;

  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    finalRetryCount = attempt;
    const attemptStarted = performance.now();
    const startedAt = now().toISOString();
    let response;
    let responseText = "";
    let responseBody;
    let failure;

    try {
      response = await fetchImpl(`${baseUrl}/api/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: task.draft_text, sourceUrl: "" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      responseText = await response.text();
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        failure = parsingFailure(response);
      }

      if (!failure && !response.ok) failure = apiFailure(response, responseBody);
      if (!failure) {
        try {
          validateReviewApiResponse(responseBody);
        } catch (error) {
          failure = {
            errorType: error.errorType ?? "Validation",
            errorCode: error.errorCode ?? "INVALID_REVIEW_RESPONSE",
            message: error.message,
            retryable: error.retryable !== false,
            httpStatus: response.status,
          };
        }
      }
    } catch (error) {
      failure = safeFetchFailure(error);
    }

    const attemptCompletedAt = now().toISOString();
    const attemptLatencyMs = Math.round(performance.now() - attemptStarted);
    await appendJsonl(rawLogPath, {
      schema_version: 1,
      record_type: "review_attempt",
      draft_id: task.draft_id,
      scenario_id: task.scenario_id,
      category: task.category,
      draft_sha256: draftSha256(task),
      reviewer_sha256: reviewerSha256,
      repeat_number: task.repeat_number,
      attempt_number: attempt + 1,
      started_at: startedAt,
      completed_at: attemptCompletedAt,
      latency_ms: attemptLatencyMs,
      http_status: response?.status ?? null,
      outcome: failure ? "error" : "success",
      error: failure
        ? { type: failure.errorType, code: failure.errorCode, message: failure.message, retryable: failure.retryable }
        : null,
      response: responseBody ?? null,
      response_text: responseBody === undefined && responseText ? responseText : null,
    });

    if (!failure) {
      return successResult(
        task,
        responseBody,
        attempt,
        Math.round(performance.now() - taskStarted),
        modelName,
        attemptCompletedAt,
        response.status,
        reviewerSha256,
      );
    }

    finalFailure = failure;
    if (!failure.retryable || attempt >= retryLimit) break;
    await sleepImpl(backoffMs * (2 ** attempt));
  }

  return errorResult(
    task,
    finalFailure,
    finalRetryCount,
    Math.round(performance.now() - taskStarted),
    modelName,
    now().toISOString(),
    reviewerSha256,
  );
}

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    this.waiters.shift()?.();
  }

  async use(callback) {
    await this.acquire();
    try {
      return await callback();
    } finally {
      this.release();
    }
  }
}

export function buildTasks(dataset, { repeats = 1, smoke = false } = {}) {
  const selected = smoke
    ? CATEGORY_CONFIG.flatMap(({ name }) => dataset.filter((draft) => draft.category === name).slice(0, 1))
    : dataset;
  return selected.flatMap((draft) =>
    Array.from({ length: repeats }, (_, index) => ({ ...draft, repeat_number: index + 1 })),
  );
}

export function progressSnapshot(tasks, resultMap, startedAtMs, sessionErrorKeys = new Set()) {
  const selectedKeys = new Set(tasks.map(resultKey));
  const categoryRows = CATEGORY_CONFIG.map(({ name }) => {
    const categoryTasks = tasks.filter((task) => task.category === name);
    const completed = categoryTasks.filter((task) => {
      const result = resultMap.get(resultKey(task));
      return result?.test_status === "Success" || sessionErrorKeys.has(resultKey(task));
    }).length;
    return { name, completed, total: categoryTasks.length, remaining: categoryTasks.length - completed };
  });
  const completed = [...selectedKeys].filter((key) => {
    const result = resultMap.get(key);
    return result?.test_status === "Success" || sessionErrorKeys.has(key);
  }).length;
  return {
    categories: categoryRows,
    completed,
    total: tasks.length,
    remaining: tasks.length - completed,
    errors: [...sessionErrorKeys].filter((key) => selectedKeys.has(key)).length,
    elapsedMs: Math.max(0, Date.now() - startedAtMs),
  };
}

export function formatProgress(snapshot) {
  const percentage = (value, total) => (total === 0 ? "100.0" : ((value / total) * 100).toFixed(1));
  const lines = snapshot.categories.map(({ name, completed, total, remaining }) =>
    `${name}: ${completed}/${total} completed (${percentage(completed, total)}%); ${remaining} remaining (${percentage(remaining, total)}%)`,
  );
  lines.push(
    `Overall: ${snapshot.completed}/${snapshot.total} completed (${percentage(snapshot.completed, snapshot.total)}%); ${snapshot.remaining} remaining (${percentage(snapshot.remaining, snapshot.total)}%)`,
    `Errors: ${snapshot.errors}`,
    `Elapsed time: ${formatDuration(snapshot.elapsedMs)}`,
  );
  return lines.join("\n");
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

export async function runCategoryWorkers({
  tasks,
  existingResults,
  resultsPath,
  requestOptions,
  concurrency = 5,
  force = false,
  onProgress = () => {},
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
    throw new Error("concurrency must be an integer from 1 to 5.");
  }
  const resultMap = new Map(existingResults.map((result) => [resultKey(result), result]));
  for (const task of tasks) {
    const key = resultKey(task);
    const existing = resultMap.get(key);
    const fingerprintChanged = existing && existing.draft_sha256 !== draftSha256(task);
    const reviewerChanged =
      existing &&
      requestOptions.reviewerSha256 &&
      existing.reviewer_sha256 !== requestOptions.reviewerSha256;
    if (force || fingerprintChanged || reviewerChanged) resultMap.delete(key);
  }

  const pending = tasks.filter((task) => {
    const existing = resultMap.get(resultKey(task));
    return force || existing?.test_status !== "Success";
  });
  const pendingByCategory = new Map(
    CATEGORY_CONFIG.map(({ name }) => [
      name,
      pending
        .filter((task) => task.category === name)
        .sort((left, right) => Number(left.global_order) - Number(right.global_order) || left.repeat_number - right.repeat_number),
    ]),
  );
  const semaphore = new Semaphore(concurrency);
  const sessionErrorKeys = new Set();
  const startedAtMs = Date.now();
  let persistenceChain = Promise.resolve();

  const persistAndReport = () => {
    const resultSnapshot = [...resultMap.values()];
    const progress = progressSnapshot(tasks, resultMap, startedAtMs, new Set(sessionErrorKeys));
    const operation = persistenceChain.then(async () => {
      await writeResultsCsv(resultsPath, resultSnapshot);
      await onProgress(progress);
    });
    persistenceChain = operation.catch(() => {});
    return operation;
  };

  await persistAndReport();

  await Promise.all(CATEGORY_CONFIG.map(async ({ name }) => {
    for (const task of pendingByCategory.get(name)) {
      const result = await semaphore.use(() => reviewTask(task, requestOptions));
      const key = resultKey(result);
      resultMap.set(key, result);
      if (result.test_status === "Error") sessionErrorKeys.add(key);
      else sessionErrorKeys.delete(key);
      await persistAndReport();
    }
  }));

  return sortResults([...resultMap.values()]);
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function populationStandardDeviation(values) {
  if (values.length === 0) return null;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function percentage(count, denominator) {
  return denominator === 0 ? null : count / denominator;
}

export function analyzeResults(dataset, results) {
  const successful = results.filter((result) => result.test_status === "Success");
  const errors = results.filter((result) => result.test_status === "Error");
  const byDraft = new Map();
  for (const draft of dataset) {
    const runs = successful.filter((result) => result.draft_id === draft.draft_id);
    const scores = runs.map((result) => Number(result.actual_overall_score));
    const averageScore = mean(scores);
    const distance = averageScore === null
      ? { below: null, above: null, distance: null }
      : rangeDistance(averageScore, draft.expected_min, draft.expected_max);
    byDraft.set(draft.draft_id, {
      ...draft,
      successful_runs: runs.length,
      average_score: averageScore,
      predicted_category: averageScore === null ? "" : predictCategory(averageScore),
      ...distance,
      run_spread: scores.length < 2 ? 0 : Math.max(...scores) - Math.min(...scores),
    });
  }

  const categorySummary = CATEGORY_CONFIG.map(({ name, minimum, maximum }) => {
    const categoryRuns = successful.filter((result) => result.category === name);
    const categoryErrors = errors.filter((result) => result.category === name);
    const scores = categoryRuns.map((result) => Number(result.actual_overall_score));
    const inside = categoryRuns.filter((result) => result.in_expected_range === "Yes").length;
    const below = categoryRuns.filter((result) => Number(result.distance_below_expected_range) > 0).length;
    const above = categoryRuns.filter((result) => Number(result.distance_above_expected_range) > 0).length;
    const correct = categoryRuns.filter((result) => result.category_correct === "Yes").length;
    const distances = categoryRuns.map((result) => Number(result.distance_from_expected_range));
    return {
      category: name,
      expected_min: minimum,
      expected_max: maximum,
      successful_tests: categoryRuns.length,
      failed_tests: categoryErrors.length,
      average: mean(scores),
      median: median(scores),
      minimum: scores.length ? Math.min(...scores) : null,
      maximum: scores.length ? Math.max(...scores) : null,
      standard_deviation: populationStandardDeviation(scores),
      inside_count: inside,
      inside_percentage: percentage(inside, categoryRuns.length),
      below_count: below,
      below_percentage: percentage(below, categoryRuns.length),
      above_count: above,
      above_percentage: percentage(above, categoryRuns.length),
      mean_distance: mean(distances),
      correct_count: correct,
      classification_accuracy: percentage(correct, categoryRuns.length),
    };
  });

  const draftAggregates = [...byDraft.values()];
  const scoredDrafts = draftAggregates.filter((draft) => draft.average_score !== null);
  const correctlyClassifiedDrafts = scoredDrafts.filter((draft) => draft.predicted_category === draft.category).length;
  const confusionMatrix = Object.fromEntries(CATEGORY_CONFIG.map(({ name: expected }) => [
    expected,
    Object.fromEntries(CATEGORY_CONFIG.map(({ name: predicted }) => [
      predicted,
      scoredDrafts.filter((draft) => draft.category === expected && draft.predicted_category === predicted).length,
    ])),
  ]));

  const inversions = [];
  for (let scenario = 1; scenario <= 30; scenario += 1) {
    const scenarioId = String(scenario).padStart(3, "0");
    const versions = CATEGORY_CONFIG.map(({ name }) =>
      draftAggregates.find((draft) => draft.scenario_id === scenarioId && draft.category === name),
    );
    for (let higherIndex = 0; higherIndex < versions.length; higherIndex += 1) {
      for (let lowerIndex = higherIndex + 1; lowerIndex < versions.length; lowerIndex += 1) {
        const higher = versions[higherIndex];
        const lower = versions[lowerIndex];
        if (!higher || !lower || higher.average_score === null || lower.average_score === null) continue;
        if (lower.average_score > higher.average_score) {
          inversions.push({
            scenario_id: scenarioId,
            higher_quality_draft_id: higher.draft_id,
            higher_quality_category: higher.category,
            higher_quality_score: higher.average_score,
            lower_quality_draft_id: lower.draft_id,
            lower_quality_category: lower.category,
            lower_quality_score: lower.average_score,
            inversion_gap: lower.average_score - higher.average_score,
          });
        }
      }
    }
  }
  inversions.sort((left, right) => right.inversion_gap - left.inversion_gap || left.scenario_id.localeCompare(right.scenario_id));

  const largestMismatches = scoredDrafts
    .map((draft) => ({
      draft_id: draft.draft_id,
      scenario_id: draft.scenario_id,
      expected_category: draft.category,
      predicted_category: draft.predicted_category,
      expected_range: `${draft.expected_min}-${draft.expected_max}`,
      average_score: draft.average_score,
      distance_from_range: draft.distance,
      direction: draft.below > 0 ? "Below" : draft.above > 0 ? "Above" : "Inside",
    }))
    .filter((item) => item.distance_from_range > 0)
    .sort((left, right) => right.distance_from_range - left.distance_from_range || left.draft_id.localeCompare(right.draft_id))
    .slice(0, 10);

  const errorGroupsMap = new Map();
  for (const error of errors) {
    const groupKey = `${error.error_code || "UNKNOWN"}::${error.error_message || ""}`;
    const group = errorGroupsMap.get(groupKey) ?? {
      error_code: error.error_code || "UNKNOWN",
      error_message: error.error_message || "",
      count: 0,
      draft_ids: [],
    };
    group.count += 1;
    group.draft_ids.push(error.draft_id);
    errorGroupsMap.set(groupKey, group);
  }
  const repeatedErrors = [...errorGroupsMap.values()]
    .filter((group) => group.count >= 2)
    .sort((left, right) => right.count - left.count || left.error_code.localeCompare(right.error_code));

  const suspiciousPatterns = [];
  if (repeatedErrors.length > 0) {
    suspiciousPatterns.push(`${repeatedErrors.length} repeated error pattern(s) occurred.`);
  }
  if (inversions.length > 0) {
    suspiciousPatterns.push(`${inversions.length} lower-quality/higher-score inversion(s) were detected.`);
  }
  const categoryMeans = categorySummary.map((summary) => summary.average);
  for (let index = 1; index < categoryMeans.length; index += 1) {
    if (categoryMeans[index - 1] !== null && categoryMeans[index] !== null && categoryMeans[index] >= categoryMeans[index - 1]) {
      suspiciousPatterns.push(
        `${CATEGORY_CONFIG[index].name} mean score (${categoryMeans[index].toFixed(1)}) is not below ${CATEGORY_CONFIG[index - 1].name} (${categoryMeans[index - 1].toFixed(1)}).`,
      );
    }
  }
  const scoreFrequency = new Map();
  for (const result of successful) {
    const score = Number(result.actual_overall_score);
    scoreFrequency.set(score, (scoreFrequency.get(score) ?? 0) + 1);
  }
  for (const [score, count] of scoreFrequency) {
    if (successful.length >= 10 && count / successful.length >= 0.2) {
      suspiciousPatterns.push(`Score ${score} appears in ${count}/${successful.length} successful tests (${((count / successful.length) * 100).toFixed(1)}%).`);
    }
  }
  const capCount = successful.filter((result) => [39, 59, 74, 89].includes(Number(result.actual_overall_score))).length;
  if (successful.length >= 10 && capCount / successful.length >= 0.3) {
    suspiciousPatterns.push(`${capCount}/${successful.length} scores (${((capCount / successful.length) * 100).toFixed(1)}%) sit exactly on deterministic cap boundaries 39, 59, 74, or 89.`);
  }
  const unstableDrafts = scoredDrafts.filter((draft) => draft.run_spread > 10);
  if (unstableDrafts.length > 0) {
    suspiciousPatterns.push(`${unstableDrafts.length} draft(s) have a repeat-run score spread above 10 points.`);
  }
  for (const summary of categorySummary) {
    if (summary.successful_tests > 1 && summary.standard_deviation === 0) {
      suspiciousPatterns.push(`${summary.category} has zero score variance across ${summary.successful_tests} successful tests.`);
    }
  }
  if (suspiciousPatterns.length === 0) suspiciousPatterns.push("No repeated errors or predefined suspicious scoring patterns were detected.");

  const calibrationNotes = categorySummary.map((summary) => {
    if (summary.successful_tests === 0) return `${summary.category}: no successful tests are available.`;
    return `${summary.category}: ${summary.inside_count}/${summary.successful_tests} (${(summary.inside_percentage * 100).toFixed(1)}%) inside ${summary.expected_min}-${summary.expected_max}; ${summary.below_count} below and ${summary.above_count} above; mean score ${summary.average.toFixed(1)}.`;
  });
  calibrationNotes.push(
    scoredDrafts.length === 0
      ? "Overall: no successful draft scores are available."
      : `Overall scored-draft classification accuracy is ${correctlyClassifiedDrafts}/${scoredDrafts.length} (${((correctlyClassifiedDrafts / scoredDrafts.length) * 100).toFixed(1)}%); coverage is ${scoredDrafts.length}/${dataset.length}, so all-draft accuracy is ${correctlyClassifiedDrafts}/${dataset.length} (${((correctlyClassifiedDrafts / dataset.length) * 100).toFixed(1)}%).`,
  );

  return {
    successful_tests: successful.length,
    failed_tests: errors.length,
    scored_drafts: scoredDrafts.length,
    unscored_drafts: dataset.length - scoredDrafts.length,
    run_inside_range_count: successful.filter((result) => result.in_expected_range === "Yes").length,
    run_inside_range_percentage: percentage(successful.filter((result) => result.in_expected_range === "Yes").length, successful.length),
    run_classification_accuracy: percentage(successful.filter((result) => result.category_correct === "Yes").length, successful.length),
    draft_classification_accuracy: percentage(correctlyClassifiedDrafts, scoredDrafts.length),
    draft_coverage: percentage(scoredDrafts.length, dataset.length),
    overall_accuracy_all_drafts: percentage(correctlyClassifiedDrafts, dataset.length),
    category_summary: categorySummary,
    confusion_matrix: confusionMatrix,
    inversions,
    largest_mismatches: largestMismatches,
    repeated_errors: repeatedErrors,
    suspicious_patterns: suspiciousPatterns,
    calibration_notes: calibrationNotes,
    error_rows: errors,
    draft_aggregates: draftAggregates,
  };
}
