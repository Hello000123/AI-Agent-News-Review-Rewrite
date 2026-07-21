# Traditional Chinese Review Agent calibration suite

This isolated test suite sends 150 fictional Traditional Chinese (Hong Kong) drafts through the existing production-facing `POST /api/review` route. It does not copy, replace, or alter the Review Agent prompt, scoring rules, parser, caps, or production workflow.

## Files

- `chinese_review_drafts.csv` — reusable 150-draft dataset, encoded as UTF-8 with BOM.
- `run-chinese-review-test.mjs` — command-line runner.
- `review-test-lib.mjs` — validation, concurrency, retry, persistence, resume, and analysis logic.
- `build-xlsx-report.mjs` — workbook builder and workbook verification.
- `review-test-lib.test.mjs` — no-AI harness tests.
- `chinese_review_results.csv` — incrementally saved per-run results.
- `chinese_review_responses.jsonl` — append-only complete local `/api/review` response log.
- `chinese_review_test_report.xlsx` — report with Drafts, Results, Summary, Category Summary, and Error Log sheets.

The public review response contains six component scores, `weightedScore`, optional `appliedScoreCap`, and the backend-authoritative `overallScore`. The runner preserves all of these and uses `review.overallScore` for expected-range evaluation.

## Requirements and configuration

- Node.js 22.13 or later (the project already requires this).
- Project dependencies installed with `npm install`.
- A running local application. Next.js reads the existing server-only DeepSeek settings from `.env.local`; the runner never hard-codes or prints the API key.
- Workbook generation uses the Codex-bundled `@oai/artifact-tool` runtime. The runner auto-discovers the local bundle. If it is elsewhere, set `CODEX_ARTIFACT_NODE_MODULES` to its `node_modules` directory.

The model label is read in this order: `EVAL_MODEL`, `DEEPSEEK_MODEL` in the current environment, the non-secret `DEEPSEEK_MODEL` value in `.env.local`, then `server-configured-model`. Successful `/api/review` responses do not themselves expose a model name.

Start the application in one PowerShell window:

```powershell
cd "C:\AI\AI-Agent-News-Review-Rewrite"
npm run dev
```

Run suite commands in a second PowerShell window from the same project directory.

## Commands

Validate all 150 drafts and rebuild reports without calling the Review Agent or any AI:

```powershell
node tests\chinese-review-calibration\run-chinese-review-test.mjs --dry-run
```

Run one draft from each category (five paid review requests unless already successful):

```powershell
node tests\chinese-review-calibration\run-chinese-review-test.mjs --smoke
```

Run the complete test (150 paid review requests at the default one repeat). Obtain approval before doing this:

```powershell
node tests\chinese-review-calibration\run-chinese-review-test.mjs
```

Resume an interrupted complete test. This is intentionally the same command; successful draft/repeat pairs are skipped and errors are retried:

```powershell
node tests\chinese-review-calibration\run-chinese-review-test.mjs
```

Force a complete rerun and replace matching CSV result rows. The raw JSONL attempt history remains append-only:

```powershell
node tests\chinese-review-calibration\run-chinese-review-test.mjs --force
```

Run the no-AI harness tests:

```powershell
node --test tests\chinese-review-calibration\review-test-lib.test.mjs
```

Useful options:

```text
--concurrency 1..5    Maximum simultaneous review requests (default 5)
--retries 0..10       Retries after the first attempt (default 2)
--backoff-ms N        Initial exponential-backoff delay (default 1000)
--timeout-ms N        Local endpoint timeout (default: provider timeout + 30 seconds)
--repeats 1..10       Runs per draft (default 1)
--base-url URL        Application URL (default http://127.0.0.1:3000)
--report-only         Rebuild the workbook from the current CSVs without requests
--output-dir PATH     Put results, JSONL, and workbook in another directory
```

Five category workers are created. Each worker processes its category in ascending global-order/repeat order, while a shared semaphore enforces `--concurrency`. A temporary network, timeout, rate-limit, server, parsing, or response-validation failure is retried with exponential backoff. An exhausted or non-retryable failure is saved as an error; it is never converted into a zero score.

## Reading the report

Requested predicted categories use these inclusive score bands: Excellent 85–100, Good 70–84, Normal 50–69, Bad 30–49, and Extremely Bad 0–29. These test categories are separate from the Review Agent’s own readiness-band labels.

- Results contains one row per draft/repeat and records all returned score fields, range distance, predicted category, status, diagnostics, latency, model label, and timestamp.
- Category Summary reports successful/failed counts; average, median, minimum, maximum, and population standard deviation; inside/below/above rates; mean range distance; and classification accuracy.
- Summary contains overall metrics (including scored-draft accuracy, coverage, and accuracy across all 150 planned drafts), a confusion matrix, the ten largest out-of-range mismatches, all lower-quality/higher-score inversions, repeated errors, suspicious patterns, and a plain-language calibration interpretation.
- Error Log contains failures only.

With `--repeats` above one, test-level statistics use every successful repeat. Draft-level accuracy, mismatch ranking, and within-scenario inversion checks use the mean of each draft’s successful repeats. The raw JSONL log contains the complete local API body for debugging, including the echoed source draft, but never request headers, environment secrets, private model reasoning, or the unexposed upstream provider envelope.
