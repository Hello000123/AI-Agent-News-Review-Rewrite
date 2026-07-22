import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { CATEGORY_CONFIG, DATASET_HEADERS, RESULT_HEADERS } from "./review-test-lib.mjs";

const COLORS = Object.freeze({
  navy: "#17324D",
  teal: "#087E8B",
  paleTeal: "#DDF3F4",
  paleBlue: "#EAF1F8",
  green: "#DCFCE7",
  greenText: "#166534",
  amber: "#FEF3C7",
  amberText: "#92400E",
  red: "#FEE2E2",
  redText: "#991B1B",
  grey: "#F3F4F6",
  darkGrey: "#374151",
  border: "#CBD5E1",
  white: "#FFFFFF",
});

const DATASET_LABELS = Object.freeze({
  global_order: "Global order",
  draft_id: "Draft ID",
  scenario_id: "Scenario ID",
  category: "Category",
  expected_min: "Expected minimum",
  expected_max: "Expected maximum",
  draft_text: "Complete draft text",
});

const RESULT_LABELS = Object.freeze({
  global_order: "Global order",
  draft_id: "Draft ID",
  scenario_id: "Scenario ID",
  category: "Category",
  expected_min: "Expected minimum",
  expected_max: "Expected maximum",
  repeat_number: "Repeat",
  actual_overall_score: "Actual overall score",
  factual_completeness_score: "Factual completeness",
  structure_score: "Structure",
  clarity_score: "Clarity",
  language_quality_score: "Language quality",
  professionalism_score: "Professionalism",
  attribution_score: "Attribution",
  weighted_score: "Weighted score",
  applied_score_cap: "Applied score cap",
  in_expected_range: "In expected range",
  distance_from_expected_range: "Distance from range",
  distance_below_expected_range: "Distance below",
  distance_above_expected_range: "Distance above",
  predicted_category: "Predicted category",
  category_correct: "Category correct",
  readiness_band: "Readiness band",
  decision: "Decision",
  pass_score: "Pass score",
  test_status: "Test status",
  error_type: "Error type",
  error_code: "Error code",
  error_message: "Error message",
  retry_count: "Retry count",
  response_time_ms: "Response time (ms)",
  model_name: "Model name",
  test_timestamp: "Test timestamp",
  http_status: "HTTP status",
  draft_sha256: "Draft SHA-256",
  reviewer_sha256: "Reviewer SHA-256",
});

async function loadArtifactTool() {
  try {
    return await import("@oai/artifact-tool");
  } catch {
    const nodeModulesRoot =
      process.env.CODEX_ARTIFACT_NODE_MODULES?.trim() ||
      (process.env.USERPROFILE
        ? path.join(
            process.env.USERPROFILE,
            ".cache",
            "codex-runtimes",
            "codex-primary-runtime",
            "dependencies",
            "node",
            "node_modules",
          )
        : "");
    if (!nodeModulesRoot) {
      throw new Error(
        "@oai/artifact-tool is unavailable. Set CODEX_ARTIFACT_NODE_MODULES to the bundled workspace node_modules path.",
      );
    }
    const resolver = createRequire(path.join(nodeModulesRoot, "artifact-tool-resolver.cjs"));
    let entry;
    try {
      entry = resolver.resolve("@oai/artifact-tool");
    } catch (error) {
      throw new Error(
        `@oai/artifact-tool is unavailable under CODEX_ARTIFACT_NODE_MODULES (${error.message}).`,
      );
    }
    return import(pathToFileURL(entry).href);
  }
}

function displayValue(value) {
  return value === "" || value === undefined ? null : value;
}

function excelColumn(index) {
  let value = index;
  let letters = "";
  while (value > 0) {
    value -= 1;
    letters = String.fromCharCode(65 + (value % 26)) + letters;
    value = Math.floor(value / 26);
  }
  return letters;
}

function styleHeader(range) {
  range.format = {
    fill: COLORS.navy,
    font: { bold: true, color: COLORS.white, size: 10 },
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "outside", style: "thin", color: COLORS.border },
  };
}

function styleTitle(sheet, rangeAddress, title) {
  const range = sheet.getRange(rangeAddress);
  range.merge();
  range.values = [[title]];
  range.format = {
    fill: COLORS.navy,
    font: { bold: true, color: COLORS.white, size: 18 },
    verticalAlignment: "center",
    rowHeight: 34,
  };
}

function styleSection(sheet, rangeAddress, title) {
  const range = sheet.getRange(rangeAddress);
  range.merge();
  range.values = [[title]];
  range.format = {
    fill: COLORS.teal,
    font: { bold: true, color: COLORS.white, size: 11 },
    verticalAlignment: "center",
    rowHeight: 24,
  };
}

function addTableWhenPopulated(sheet, address, name) {
  const [start, end] = address.split(":");
  if (start === end) return null;
  return sheet.tables.add(address, true, name);
}

function setColumnWidths(sheet, widths, lastRow) {
  for (const [column, width] of Object.entries(widths)) {
    sheet.getRange(`${column}1:${column}${lastRow}`).format.columnWidth = width;
  }
}

function nonEmptyText(value, fallback = "None detected.") {
  return value && String(value).trim() ? String(value) : fallback;
}

export async function buildXlsxReport({
  dataset,
  results,
  analysis,
  outputPath,
  runConfig,
  previewDirectory = "",
}) {
  const { Workbook, SpreadsheetFile } = await loadArtifactTool();
  const workbook = Workbook.create();
  const draftsSheet = workbook.worksheets.add("Drafts");
  const resultsSheet = workbook.worksheets.add("Results");
  const summarySheet = workbook.worksheets.add("Summary");
  const categorySheet = workbook.worksheets.add("Category Summary");
  const errorSheet = workbook.worksheets.add("Error Log");

  for (const sheet of [draftsSheet, resultsSheet, summarySheet, categorySheet, errorSheet]) {
    sheet.showGridLines = false;
  }

  const draftHeaders = DATASET_HEADERS.map((header) => DATASET_LABELS[header]);
  const draftRows = dataset.map((draft) => DATASET_HEADERS.map((header) => displayValue(draft[header])));
  draftsSheet.getRange(`A1:G${draftRows.length + 1}`).values = [draftHeaders, ...draftRows];
  styleHeader(draftsSheet.getRange("A1:G1"));
  draftsSheet.getRange(`A2:F${draftRows.length + 1}`).format.verticalAlignment = "top";
  draftsSheet.getRange(`G2:G${draftRows.length + 1}`).format = {
    wrapText: true,
    verticalAlignment: "top",
  };
  draftsSheet.getRange(`A2:A${draftRows.length + 1}`).format.numberFormat = "000";
  draftsSheet.getRange(`C2:C${draftRows.length + 1}`).format.numberFormat = "000";
  draftsSheet.getRange(`E2:F${draftRows.length + 1}`).format.numberFormat = "0";
  draftsSheet.freezePanes.freezeRows(1);
  draftsSheet.freezePanes.freezeColumns(2);
  setColumnWidths(draftsSheet, { A: 12, B: 26, C: 12, D: 18, E: 14, F: 14, G: 92 }, draftRows.length + 1);
  draftsSheet.getRange(`A2:G${draftRows.length + 1}`).format.autofitRows();
  addTableWhenPopulated(draftsSheet, `A1:G${draftRows.length + 1}`, "ChineseReviewDraftsTable");

  const resultHeaders = RESULT_HEADERS.map((header) => RESULT_LABELS[header]);
  const resultRows = results.map((result) => RESULT_HEADERS.map((header) => displayValue(result[header])));
  resultsSheet.getRange(`A1:${excelColumn(RESULT_HEADERS.length)}${resultRows.length + 1}`).values = [
    resultHeaders,
    ...resultRows,
  ];
  styleHeader(resultsSheet.getRange(`A1:${excelColumn(RESULT_HEADERS.length)}1`));
  resultsSheet.freezePanes.freezeRows(1);
  resultsSheet.freezePanes.freezeColumns(4);
  setColumnWidths(resultsSheet, {
    A: 11, B: 25, C: 11, D: 17, E: 12, F: 12, G: 9,
    H: 14, I: 14, J: 11, K: 10, L: 14, M: 14, N: 11, O: 12, P: 12,
    Q: 14, R: 13, S: 12, T: 12, U: 17, V: 14, W: 22, X: 18, Y: 10,
    Z: 12, AA: 13, AB: 24, AC: 44, AD: 10, AE: 16, AF: 22, AG: 23, AH: 11,
    AI: 24, AJ: 24,
  }, Math.max(2, resultRows.length + 1));
  if (resultRows.length > 0) {
    const resultLastRow = resultRows.length + 1;
    resultsSheet.getRange(`A2:A${resultLastRow}`).format.numberFormat = "000";
    resultsSheet.getRange(`C2:C${resultLastRow}`).format.numberFormat = "000";
    resultsSheet.getRange(`H2:P${resultLastRow}`).format.numberFormat = "0.0";
    resultsSheet.getRange(`R2:T${resultLastRow}`).format.numberFormat = "0.0";
    resultsSheet.getRange(`AE2:AE${resultLastRow}`).format.numberFormat = "#,##0";
    resultsSheet.getRange(`AG2:AG${resultLastRow}`).format.numberFormat = "yyyy-mm-dd hh:mm:ss";
    resultsSheet.getRange(`AC2:AC${resultLastRow}`).format.wrapText = true;
    resultsSheet.getRange(`Q2:Q${resultLastRow}`).conditionalFormats.add("containsText", {
      text: "Yes",
      format: { fill: COLORS.green, font: { color: COLORS.greenText, bold: true } },
    });
    resultsSheet.getRange(`Q2:Q${resultLastRow}`).conditionalFormats.add("containsText", {
      text: "No",
      format: { fill: COLORS.red, font: { color: COLORS.redText, bold: true } },
    });
    resultsSheet.getRange(`Z2:Z${resultLastRow}`).conditionalFormats.add("containsText", {
      text: "Error",
      format: { fill: COLORS.red, font: { color: COLORS.redText, bold: true } },
    });
    resultsSheet.getRange(`H2:H${resultLastRow}`).conditionalFormats.add("dataBar", {
      color: COLORS.teal,
      gradient: true,
      thresholds: [{ type: "num", value: 0 }, { type: "num", value: 100 }],
    });
    addTableWhenPopulated(
      resultsSheet,
      `A1:${excelColumn(RESULT_HEADERS.length)}${resultLastRow}`,
      "ChineseReviewResultsTable",
    );
  }

  const resultsLastRow = Math.max(2, resultRows.length + 1);
  const resultRange = (column) => `'Results'!$${column}$2:$${column}$${resultsLastRow}`;
  styleTitle(summarySheet, "A1:J1", "Traditional Chinese Review Agent Calibration Report");
  summarySheet.getRange("A2:J2").merge();
  summarySheet.getRange("A2:J2").values = [[
    `Generated ${new Date().toISOString()} | Model: ${runConfig.modelName} | Repeats: ${runConfig.repeats} | Mode: ${runConfig.mode}`,
  ]];
  summarySheet.getRange("A2:J2").format = {
    fill: COLORS.paleBlue,
    font: { color: COLORS.darkGrey, italic: true, size: 10 },
    rowHeight: 22,
  };

  styleSection(summarySheet, "A4:B4", "Overall summary");
  summarySheet.getRange("A5:A22").values = [
    ["Planned drafts"],
    ["Planned test runs"],
    ["Saved result rows"],
    ["Successful tests"],
    ["Failed tests"],
    ["Inside expected range (count)"],
    ["Inside expected range (%)"],
    ["Below expected range (count)"],
    ["Below expected range (%)"],
    ["Above expected range (count)"],
    ["Above expected range (%)"],
    ["Run classification accuracy"],
    ["Scored-draft classification accuracy"],
    ["Draft coverage"],
    ["Overall accuracy across all drafts"],
    ["Mean successful score"],
    ["Mean distance from expected range"],
    ["Inversion cases"],
  ];
  summarySheet.getRange("A5:A22").format = { fill: COLORS.grey, font: { bold: true, color: COLORS.darkGrey } };
  summarySheet.getRange("B5:B22").formulas = [
    ["=COUNTA('Drafts'!$B$2:$B$151)"],
    [`=${runConfig.plannedTests}`],
    [`=COUNTA(${resultRange("B")})`],
    [`=COUNTIF(${resultRange("Z")},\"Success\")`],
    [`=COUNTIF(${resultRange("Z")},\"Error\")`],
    [`=COUNTIFS(${resultRange("Z")},\"Success\",${resultRange("Q")},\"Yes\")`],
    ["=IF(B8=0,0,B10/B8)"],
    [`=COUNTIFS(${resultRange("Z")},\"Success\",${resultRange("S")},\">0\")`],
    ["=IF(B8=0,0,B12/B8)"],
    [`=COUNTIFS(${resultRange("Z")},\"Success\",${resultRange("T")},\">0\")`],
    ["=IF(B8=0,0,B14/B8)"],
    [`=IF(B8=0,0,COUNTIF(${resultRange("V")},\"Yes\")/B8)`],
    [`=IF(B8=0,\"\",${analysis.draft_classification_accuracy ?? 0})`],
    [`=${analysis.draft_coverage ?? 0}`],
    [`=${analysis.overall_accuracy_all_drafts ?? 0}`],
    [`=IF(B8=0,\"\",AVERAGEIF(${resultRange("Z")},\"Success\",${resultRange("H")}))`],
    [`=IF(B8=0,\"\",AVERAGEIF(${resultRange("Z")},\"Success\",${resultRange("R")}))`],
    [`=${analysis.inversions.length}`],
  ];
  summarySheet.getRange("B5:B22").format = { fill: COLORS.white, font: { bold: true, color: COLORS.navy } };
  summarySheet.getRange("B11:B11").format.numberFormat = "0.0%";
  summarySheet.getRange("B13:B13").format.numberFormat = "0.0%";
  summarySheet.getRange("B15:B19").format.numberFormat = "0.0%";
  summarySheet.getRange("B20:B21").format.numberFormat = "0.0";
  summarySheet.getRange("A4:B22").format.borders = { preset: "all", style: "thin", color: COLORS.border };

  styleSection(summarySheet, "D4:J4", "Calibration interpretation");
  const interpretationRows = analysis.calibration_notes.map((note) => [note, null, null, null, null, null, null]);
  summarySheet.getRange(`D5:J${4 + interpretationRows.length}`).values = interpretationRows;
  summarySheet.getRange(`D5:J${4 + interpretationRows.length}`).merge(true);
  summarySheet.getRange(`D5:J${4 + interpretationRows.length}`).format = {
    wrapText: true,
    verticalAlignment: "top",
    fill: COLORS.paleTeal,
    font: { color: COLORS.darkGrey },
    rowHeight: 30,
  };

  styleSection(summarySheet, "A25:G25", "Confusion matrix (successful test runs; expected rows vs predicted columns)");
  summarySheet.getRange("A26:G26").values = [[
    "Expected / Predicted",
    ...CATEGORY_CONFIG.map(({ name }) => name),
    "Row total",
  ]];
  styleHeader(summarySheet.getRange("A26:G26"));
  for (let index = 0; index < CATEGORY_CONFIG.length; index += 1) {
    const row = 27 + index;
    summarySheet.getRange(`A${row}`).values = [[CATEGORY_CONFIG[index].name]];
    summarySheet.getRange(`B${row}:F${row}`).formulas = [[...CATEGORY_CONFIG.map((_, predictedIndex) => {
      const predictedColumn = excelColumn(2 + predictedIndex);
      return `=COUNTIFS(${resultRange("D")},$A${row},${resultRange("U")},${predictedColumn}$26,${resultRange("Z")},\"Success\")`;
    })]];
    summarySheet.getRange(`G${row}`).formulas = [[`=SUM(B${row}:F${row})`]];
  }
  summarySheet.getRange("A27:A31").format = { fill: COLORS.grey, font: { bold: true } };
  summarySheet.getRange("B27:G31").format.numberFormat = "0";
  summarySheet.getRange("A26:G31").format.borders = { preset: "all", style: "thin", color: COLORS.border };

  styleSection(summarySheet, "A34:H34", "Ten largest scoring mismatches");
  summarySheet.getRange("A35:H35").values = [[
    "Rank", "Draft ID", "Scenario", "Expected", "Predicted", "Expected range", "Average score", "Distance",
  ]];
  styleHeader(summarySheet.getRange("A35:H35"));
  const mismatchRows = analysis.largest_mismatches.length
    ? analysis.largest_mismatches.map((item, index) => [
        index + 1,
        item.draft_id,
        item.scenario_id,
        item.expected_category,
        item.predicted_category,
        item.expected_range,
        item.average_score,
        item.distance_from_range,
      ])
    : [[
        null,
        analysis.scored_drafts === 0
          ? "No scored drafts are available."
          : "No out-of-range scoring mismatches were found.",
        null, null, null, null, null, null,
      ]];
  summarySheet.getRange(`A36:H${35 + mismatchRows.length}`).values = mismatchRows;
  summarySheet.getRange(`G36:H${35 + mismatchRows.length}`).format.numberFormat = "0.0";
  summarySheet.getRange(`A35:H${35 + mismatchRows.length}`).format.borders = { preset: "inside", style: "thin", color: COLORS.border };

  const inversionStart = 38 + mismatchRows.length;
  styleSection(summarySheet, `A${inversionStart}:H${inversionStart}`, "Lower-quality versions that scored higher");
  summarySheet.getRange(`A${inversionStart + 1}:H${inversionStart + 1}`).values = [[
    "Scenario", "Higher-quality draft", "Higher category", "Higher score",
    "Lower-quality draft", "Lower category", "Lower score", "Gap",
  ]];
  styleHeader(summarySheet.getRange(`A${inversionStart + 1}:H${inversionStart + 1}`));
  const inversionRows = analysis.inversions.length
    ? analysis.inversions.map((item) => [
        item.scenario_id,
        item.higher_quality_draft_id,
        item.higher_quality_category,
        item.higher_quality_score,
        item.lower_quality_draft_id,
        item.lower_quality_category,
        item.lower_quality_score,
        item.inversion_gap,
      ])
    : [[null, "No inversion cases detected.", null, null, null, null, null, null]];
  summarySheet.getRange(`A${inversionStart + 2}:H${inversionStart + 1 + inversionRows.length}`).values = inversionRows;
  summarySheet.getRange(`D${inversionStart + 2}:H${inversionStart + 1 + inversionRows.length}`).format.numberFormat = "0.0";

  const patternStart = inversionStart + inversionRows.length + 4;
  styleSection(summarySheet, `A${patternStart}:J${patternStart}`, "Repeated errors and suspicious patterns");
  const patternRows = analysis.suspicious_patterns.map((pattern) => [pattern, null, null, null, null, null, null, null, null, null]);
  summarySheet.getRange(`A${patternStart + 1}:J${patternStart + patternRows.length}`).values = patternRows;
  summarySheet.getRange(`A${patternStart + 1}:J${patternStart + patternRows.length}`).merge(true);
  summarySheet.getRange(`A${patternStart + 1}:J${patternStart + patternRows.length}`).format = {
    wrapText: true,
    verticalAlignment: "top",
    fill: COLORS.amber,
    font: { color: COLORS.amberText },
    rowHeight: 28,
  };
  setColumnWidths(
    summarySheet,
    { A: 32, B: 26, C: 18, D: 18, E: 25, F: 18, G: 16, H: 14, I: 14, J: 14 },
    patternStart + patternRows.length,
  );
  summarySheet.freezePanes.freezeRows(2);

  styleTitle(categorySheet, "A1:S1", "Category Summary");
  const categoryHeaders = [
    "Category", "Expected min", "Expected max", "Successful", "Failed", "Average", "Median", "Minimum", "Maximum",
    "Std dev (population)", "Inside count", "Inside %", "Below count", "Below %", "Above count", "Above %",
    "Mean distance", "Correct count", "Accuracy",
  ];
  categorySheet.getRange("A2:S2").values = [categoryHeaders];
  styleHeader(categorySheet.getRange("A2:S2"));
  categorySheet.getRange("A3:C7").values = CATEGORY_CONFIG.map(({ name, minimum, maximum }) => [name, minimum, maximum]);
  for (let index = 0; index < CATEGORY_CONFIG.length; index += 1) {
    const row = 3 + index;
    const success = `COUNTIFS(${resultRange("D")},$A${row},${resultRange("Z")},\"Success\")`;
    categorySheet.getRange(`D${row}:S${row}`).formulas = [[
      `=${success}`,
      `=COUNTIFS(${resultRange("D")},$A${row},${resultRange("Z")},\"Error\")`,
      `=IF(D${row}=0,\"\",SUMIFS(${resultRange("H")},${resultRange("D")},$A${row},${resultRange("Z")},\"Success\")/D${row})`,
      `=IF(D${row}=0,\"\",MEDIAN(FILTER(${resultRange("H")},(${resultRange("D")}=$A${row})*(${resultRange("Z")}=\"Success\"))))`,
      `=IF(D${row}=0,\"\",MINIFS(${resultRange("H")},${resultRange("D")},$A${row},${resultRange("Z")},\"Success\"))`,
      `=IF(D${row}=0,\"\",MAXIFS(${resultRange("H")},${resultRange("D")},$A${row},${resultRange("Z")},\"Success\"))`,
      `=IF(D${row}=0,\"\",STDEV.P(FILTER(${resultRange("H")},(${resultRange("D")}=$A${row})*(${resultRange("Z")}=\"Success\"))))`,
      `=COUNTIFS(${resultRange("D")},$A${row},${resultRange("Z")},\"Success\",${resultRange("Q")},\"Yes\")`,
      `=IF(D${row}=0,0,K${row}/D${row})`,
      `=COUNTIFS(${resultRange("D")},$A${row},${resultRange("Z")},\"Success\",${resultRange("S")},\">0\")`,
      `=IF(D${row}=0,0,M${row}/D${row})`,
      `=COUNTIFS(${resultRange("D")},$A${row},${resultRange("Z")},\"Success\",${resultRange("T")},\">0\")`,
      `=IF(D${row}=0,0,O${row}/D${row})`,
      `=IF(D${row}=0,\"\",SUMIFS(${resultRange("R")},${resultRange("D")},$A${row},${resultRange("Z")},\"Success\")/D${row})`,
      `=COUNTIFS(${resultRange("D")},$A${row},${resultRange("Z")},\"Success\",${resultRange("V")},\"Yes\")`,
      `=IF(D${row}=0,0,R${row}/D${row})`,
    ]];
  }
  categorySheet.getRange("A3:A7").format = { fill: COLORS.paleBlue, font: { bold: true, color: COLORS.navy } };
  categorySheet.getRange("B3:E7").format.numberFormat = "0";
  categorySheet.getRange("F3:J7").format.numberFormat = "0.0";
  categorySheet.getRange("K3:K7").format.numberFormat = "0";
  categorySheet.getRange("L3:L7").format.numberFormat = "0.0%";
  categorySheet.getRange("M3:M7").format.numberFormat = "0";
  categorySheet.getRange("N3:N7").format.numberFormat = "0.0%";
  categorySheet.getRange("O3:O7").format.numberFormat = "0";
  categorySheet.getRange("P3:P7").format.numberFormat = "0.0%";
  categorySheet.getRange("Q3:Q7").format.numberFormat = "0.0";
  categorySheet.getRange("R3:R7").format.numberFormat = "0";
  categorySheet.getRange("S3:S7").format.numberFormat = "0.0%";
  categorySheet.getRange("A2:S7").format.borders = { preset: "all", style: "thin", color: COLORS.border };
  categorySheet.freezePanes.freezeRows(2);
  setColumnWidths(categorySheet, {
    A: 18, B: 12, C: 12, D: 11, E: 10, F: 11, G: 11, H: 11, I: 11, J: 17,
    K: 12, L: 11, M: 11, N: 10, O: 11, P: 10, Q: 13, R: 12, S: 11,
  }, 7);

  styleTitle(errorSheet, "A1:J1", "Error Log");
  const errorHeaders = [
    "Draft ID", "Scenario", "Category", "Repeat", "Error type", "Error code", "Error message", "Retry count",
    "Response time (ms)", "Timestamp",
  ];
  errorSheet.getRange("A2:J2").values = [errorHeaders];
  styleHeader(errorSheet.getRange("A2:J2"));
  const errorRows = analysis.error_rows.map((error) => [
    error.draft_id,
    error.scenario_id,
    error.category,
    error.repeat_number,
    error.error_type,
    error.error_code,
    error.error_message,
    error.retry_count,
    error.response_time_ms,
    error.test_timestamp,
  ]);
  if (errorRows.length > 0) {
    errorSheet.getRange(`A3:J${errorRows.length + 2}`).values = errorRows;
    errorSheet.getRange(`B3:B${errorRows.length + 2}`).format.numberFormat = "000";
    errorSheet.getRange(`J3:J${errorRows.length + 2}`).format.numberFormat = "yyyy-mm-dd hh:mm:ss";
    errorSheet.getRange(`G3:G${errorRows.length + 2}`).format.wrapText = true;
    addTableWhenPopulated(errorSheet, `A2:J${errorRows.length + 2}`, "ChineseReviewErrorLogTable");
  } else {
    errorSheet.getRange("A3:J3").merge();
    errorSheet.getRange("A3:J3").values = [["No errors are recorded in the current results file."]];
    errorSheet.getRange("A3:J3").format = { fill: COLORS.green, font: { color: COLORS.greenText, bold: true } };
  }
  errorSheet.freezePanes.freezeRows(2);
  setColumnWidths(
    errorSheet,
    { A: 26, B: 11, C: 18, D: 9, E: 13, F: 25, G: 54, H: 11, I: 17, J: 24 },
    Math.max(3, errorRows.length + 2),
  );

  const summaryFormulaErrors = await workbook.inspect({
    kind: "match",
    range: `Summary!A1:J${Math.min(patternStart + patternRows.length, 500)}`,
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 100 },
    maxChars: 4_000,
    summary: "Chinese review Summary formula error scan",
  });
  const categoryFormulaErrors = await workbook.inspect({
    kind: "match",
    range: "'Category Summary'!A1:S7",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 100 },
    maxChars: 4_000,
    summary: "Chinese review Category Summary formula error scan",
  });
  const formulaErrorScan = `${summaryFormulaErrors.ndjson}\n${categoryFormulaErrors.ndjson}`;
  if (/"matches"\s*:\s*[1-9]/u.test(formulaErrorScan) || /reduce is not a function/iu.test(formulaErrorScan)) {
    throw new Error(`Workbook formula verification failed: ${formulaErrorScan}`);
  }

  const summaryInspection = await workbook.inspect({
    kind: "table",
    range: "Summary!A4:J31",
    include: "values,formulas",
    tableMaxRows: 31,
    tableMaxCols: 10,
    maxChars: 8_000,
  });
  const categoryInspection = await workbook.inspect({
    kind: "table",
    range: "'Category Summary'!A1:S7",
    include: "values,formulas",
    tableMaxRows: 7,
    tableMaxCols: 19,
    maxChars: 8_000,
  });
  const inspectionFailures = `${summaryInspection.ndjson}\n${categoryInspection.ndjson}`;
  if (/#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A|reduce is not a function/iu.test(inspectionFailures)) {
    throw new Error(`Workbook key-range verification failed: ${inspectionFailures}`);
  }

  const previews = [
    ["Drafts", "A1:G8", "drafts.png"],
    ["Results", `A1:${excelColumn(RESULT_HEADERS.length)}${Math.min(resultsLastRow, 10)}`, "results.png"],
    ["Summary", `A1:J${Math.min(patternStart + patternRows.length, 80)}`, "summary.png"],
    ["Category Summary", "A1:S7", "category-summary.png"],
    ["Error Log", `A1:J${Math.max(3, Math.min(errorRows.length + 2, 12))}`, "error-log.png"],
  ];
  if (previewDirectory) await fs.mkdir(previewDirectory, { recursive: true });
  for (const [sheetName, range, filename] of previews) {
    const preview = await workbook.render({ sheetName, range, scale: 1, format: "png" });
    if (previewDirectory) {
      await fs.writeFile(
        path.join(previewDirectory, filename),
        new Uint8Array(await preview.arrayBuffer()),
      );
    }
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(outputPath);
  // artifact-tool may emit an internal inspection sidecar beside the workbook;
  // it is a build diagnostic, not one of the reusable suite outputs.
  await fs.rm(`${outputPath}.inspect.ndjson`, { force: true });
  return {
    outputPath,
    formulaErrors: formulaErrorScan,
    summaryInspection: summaryInspection.ndjson,
    categoryInspection: categoryInspection.ndjson,
    previewDirectory,
  };
}

export function reportDependencyNote() {
  return nonEmptyText(
    process.env.CODEX_ARTIFACT_NODE_MODULES,
    "Uses the Codex bundled @oai/artifact-tool runtime discovered from the local workspace dependency path.",
  );
}
