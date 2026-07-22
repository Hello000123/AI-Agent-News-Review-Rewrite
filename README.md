# PressReady — AI News Draft Review and Rewrite

PressReady is a focused local website for one workflow:

    Text or public URL → Review Agent → Calibrated score and feedback → Explicit rewrite → Validated news report

The Review Agent scores the submitted copy once and returns a structured assessment. Rewriting never starts automatically and is never skipped because a review score is high: after either a high or low score, the user can explicitly request a Rewrite Agent call or return to the source input. The rewrite uses the immutable source snapshot that produced the displayed review. After the first rewrite, `Rewrite with AI Again` opens optional concise/more-detailed controls and an improvement-instructions field before another request is made.

The project is intentionally limited to this workflow. It has no login, database, account-level history, news search, dark theme, publishing, distribution, or scheduled work. The active article and its successful rewrite turns are retained in tab-scoped `sessionStorage` so a same-tab reload can continue the current editing session; starting a new draft or changing the source clears that history. Rewrites automatically preserve the primary input language and Chinese script: English input stays English, while Traditional or Simplified Chinese input stays in the detected Chinese script.

## Technology stack

- Next.js 16 App Router and React 19
- TypeScript with strict checking
- Next.js route handlers for server-only API access
- Zod for request and AI-response validation
- Native server-side fetch for DeepSeek
- Plain responsive CSS
- Vitest for unit and route-level tests

No DeepSeek SDK, UI framework, database, or separate Express server is required.

## Folder structure

    app/
      api/review/route.ts       Review-only endpoint
      api/rewrite/route.ts      Explicit/repeated rewrite endpoint
      globals.css               Responsive white-theme interface
      layout.tsx                Metadata and document layout
      page.tsx                  Server-rendered page shell
    components/
      press-release-workspace.tsx  Client workflow and interaction state
      quotation-failure-panel.tsx  Actionable quotation-validation failures
      review-summary.tsx           Scores and written feedback
      output-panel.tsx              Final output and actions
    lib/
      client/api.ts             Safe browser-to-backend requests
      server/agents/            DeepSeek client, prompts, agents, workflow, quotation validation
      server/sources/           Bounded public-URL retrieval and source extraction
      server/config.ts          Environment configuration
      server/errors.ts          Safe typed errors
      server/http.ts            Request limits and error responses
      shared/contracts.ts       Shared Zod contracts and TypeScript types
    tests/
      fixtures/                 Review and rewrite evaluation fixtures
      *.test.ts                 Unit and API validation tests
      mock-deepseek-server.mjs  Local browser-test provider
      live-review-evaluation.mjs   Repeatable live review scoring harness
      live-rewrite-evaluation.mjs  Repeatable live rewrite harness
    .env.example
    package.json

## Installation

Requirements:

- Node.js 22.13 or newer
- npm
- A DeepSeek API key for live requests

From PowerShell:

    cd "C:\AI\AI-Agent-News-Review-Rewrite"
    npm install
    Copy-Item .env.example .env.local

Open .env.local and add the API key. Never commit that file.

## Environment variables

Required:

| Variable | Example | Purpose |
| --- | --- | --- |
| DEEPSEEK_API_KEY | your-key | Server-only DeepSeek credential |
| DEEPSEEK_MODEL | deepseek-v4-pro | Model used by both agents |
| REVIEW_PASS_SCORE | 80 | Overall score used to label a review as passing |

Optional server settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| DEEPSEEK_API_BASE_URL | https://api.deepseek.com | DeepSeek base URL; useful for isolated mock testing |
| DEEPSEEK_TIMEOUT_MS | 600000 | Per-completion abort timeout in milliseconds, from 1,000 to 600,000 |
| DEEPSEEK_STREAM | true | Stream the provider response so long reasoning remains active; `false` keeps the supported non-streaming parser |

Invalid pass scores fall back to 80. Invalid timeouts fall back to 600 seconds. Invalid stream values fall back to `true`. Restart the development server after changing environment variables.

## DeepSeek API configuration

As of July 16, 2026, the official OpenAI-compatible endpoint is:

    POST https://api.deepseek.com/chat/completions

The current project configuration uses the official `deepseek-v4-pro` model ID for both agents. The authenticated `GET https://api.deepseek.com/models` endpoint lists both `deepseek-v4-pro` and `deepseek-v4-flash`; the application never silently falls back if the configured model is rejected.

Both calls explicitly enable thinking and select the highest documented effort:

    thinking: { "type": "enabled" }
    reasoning_effort: "max"

DeepSeek returns private thinking in `reasoning_content` and the final answer in `content`. The server discards `reasoning_content` and exposes only the final answer. Upstream streaming is enabled by default and parses `delta.reasoning_content`, `delta.content`, keep-alive comments, and `[DONE]`; non-streaming `message.reasoning_content`/`message.content` responses remain supported. The review call enables JSON Output and validates the result with a strict schema. The rewrite call requests normal text. Both use a 64,000-token completion budget so maximum-effort reasoning has room to finish before the final answer.

Official references:

- [DeepSeek quick start](https://api-docs.deepseek.com/)
- [Chat Completions reference](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Available models endpoint](https://api-docs.deepseek.com/api/list-models/)
- [Thinking mode and effort control](https://api-docs.deepseek.com/guides/thinking_mode/)
- [Rate limits and keep-alive behavior](https://api-docs.deepseek.com/quick_start/rate_limit/)
- [Models and pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [JSON Output guide](https://api-docs.deepseek.com/guides/json_mode/)
- [Error codes](https://api-docs.deepseek.com/quick_start/error_codes/)

## Development

    npm run dev

Open [http://localhost:3000](http://localhost:3000).

The browser sends only the submitted text and public source URL to the local Next.js backend. The interface does not accept picture uploads or user-supplied image captions/OCR because DeepSeek V4 is text-only in this workflow. The backend retrieves public URL content, derives the rewrite language from the primary article, and calls DeepSeek with the server-only secret key. The key is never included in browser source, browser requests, API error bodies, or application logs.

## Production build

    npm run build
    npm run start

The production server also starts at [http://localhost:3000](http://localhost:3000) unless PORT is set.

## Score-first review and decision logic

REVIEW_PASS_SCORE defaults to 80.

- `/api/review` builds one immutable source snapshot and invokes only the Review Agent. It never starts a rewrite.
- If text and a URL are both supplied, the submitted text is the copy being scored and the retrieved article is supporting reference material. For a URL-only request, the extracted article becomes the primary copy.
- Every valid result shows the final score, uncapped weighted score, any deterministic cap and reasons, readiness band, six category rationales, structured findings, strengths, missing information, and recommendations.
- Both a passing/high score and a failing/low score expose `Rewrite with AI`. Clicking it makes a separate `/api/rewrite` request unless another request is already running or the reviewed source has since changed. A score never causes an automatic rewrite and never suppresses an explicit rewrite.
- Editing the text or URL clears any displayed rewrite immediately and marks the existing review as stale; a new review is required before rewriting that changed source.
- Starting a review or rewrite clears the prior output state. Request sequence IDs discard late responses, and rewrite failures never restore an older successful output.

The Review Agent returns category scores and findings, but the backend computes the authoritative weighted and final scores, readiness band, and decision. The weighting is:

- factual completeness and support: 25%;
- structure and logical flow: 20%;
- clarity and readability: 15%;
- grammar and language quality: 15%;
- news-writing professionalism: 15%;
- attribution and quotation handling: 10%.

Before weighting, the backend lowers any category score that contradicts the severity of a finding or its readiness-risk flag; it never raises a model score. The consistency-normalized weighted score is rounded to the nearest whole number. Deterministic safeguards then apply the lowest relevant cap:

- 39 for a critical finding or a draft marked severely incomplete or unreliable;
- 59 for a major finding, serious factual gap, unsupported material claim, major structural problem, very poor language, or serious attribution/quotation problem;
- 74 for a moderate finding, necessary missing information, or a category below 60;
- 89 for a minor material finding, a category below 75, or a non-optional recommendation with no matching structured finding.

The final score is the lower of the weighted score and applicable cap. Readiness bands are 90–100 publication-ready, 75–89 strong with limited editing, 60–74 requiring substantial rewriting, 40–59 weak, and 0–39 severely deficient. The backend compares the final score—not the model's claimed arithmetic or decision—with REVIEW_PASS_SCORE.

## Agent behavior

The Review Agent:

- evaluates without rewriting;
- scores the exact submitted copy across the six fixed categories and published readiness bands;
- treats retrieved article and page context as separately labelled evidence rather than transferring a publisher's reputation or reference prose quality to a user draft;
- applies equivalent standards across languages and ignores publisher reputation;
- accepts meaningful relative time expressions such as `yesterday`, `recently`, `昨天`, and `近期` as valid time information; it does not require an exact calendar date or penalize timeless copy when chronology is immaterial;
- deducts for time only when material context is absent, unclear, internally contradictory, or too vague to understand, and never invents an exact date from relative wording;
- treats media contacts, boilerplates, executive quotations, formal datelines, and calls to action as optional unless essential to the specific announcement;
- returns a required rationale for every category score, explicit readiness-risk flags, structured category/severity findings, strengths, missing information, and recommendations;
- uses temperature 0 for the most repeatable scoring the configured provider can offer;
- returns strict JSON only.

The Rewrite Agent:

- receives the immutable primary source, relevant retrieved page context, validated review feedback, an automatically derived source-language requirement, the current rewrite, retained earlier turns, all prior user instructions, and the latest optional refinement;
- treats source material as factual input and review feedback only as editing guidance;
- keeps compatible earlier improvement instructions active, gives a later conflicting instruction precedence, and applies only the latest selected length preference;
- makes `concise` output shorter and more direct without losing important facts; makes `more_detailed` output fuller only from explicit source or user-supplied information and never fabricates detail merely to add length;
- creates a concise factual headline, strong lead, inverted-pyramid structure, short paragraphs, and neutral newsroom language;
- preserves material supported facts, exact direct quotations, names, dates, numbers, attribution, uncertainty, language, and script;
- never invents facts, translations, context, causal links, quotations, or placeholders;
- removes promotional repetition and press-release artifacts without dropping material facts;
- rejects an empty or malformed candidate, a wrong-language result, changed or untraceable source numbers, omitted or romanized mandatory source-script names, omitted mandatory mixed-language terms, invented direct speech, or an exact/whitespace-only/punctuation-only source copy;
- checks high-confidence named-speaker attribution beside exact preserved quotations in English and Chinese, and routes a reassignment or lost attribution through the same single bounded source-fidelity correction;
- treats equivalent Chinese powers-of-ten and Arabic-number renderings as the same figure (for example, `5.8萬` and `58,000`) while retaining invented-number checks and the original language/script lock;
- returns only a headline, one blank line, and the news-report body after validation.

User drafts, retrieved source material, and feedback are wrapped as JSON data in the prompts and explicitly treated as untrusted content. Generated output is rendered as plain textarea text; HTML is never injected.

### Rewrite-session memory

Each validated rewrite is appended chronologically as `{ rewrittenText, lengthOption, instruction }`. On the next request, the last turn is labelled as the current rewritten version and earlier turns remain ordered, so later instructions build on the same article instead of starting an independent model call. The server remains stateless: the browser sends this context with each rewrite request.

The stable current article state is stored under one versioned `sessionStorage` key. This survives same-tab refreshes and same-tab navigation, but not the end of the browser-tab session. Editing the source, submitting a new review, or choosing `Start New Draft` clears it. Malformed stored data and storage failures are ignored safely.

Rewrite requests retain up to 24 successful turns. If a request approaches the 220 KB body limit, older rewritten version bodies are omitted from the request from oldest to newest while their instructions and preferences remain; the original source, active system rules, all retained user instructions, and the newest/current rewrite take priority.

## Quotation preservation and retry behavior

The quotation validator parses `「……」`, `『……』`, `“……”`, `‘……’`, and guarded ASCII quote forms. It uses attribution and sentence-level context to distinguish direct quotations from short labels, supports nested and repeated quotations, and allocates duplicate matches one-to-one. Leading or trailing whitespace and normalized Unicode punctuation forms do not create false failures, but wording and internal punctuation must remain exact.

Validation identifies modified, omitted, split, merged, and punctuation-changed quotations. If the first rewrite is unchanged or fails deterministic format, language, name, number, or quotation validation, the backend makes one focused correction request, for at most two Rewrite Agent calls in that user request; there is no unlimited retry loop. Format, source-name, source-echo, and quotation retries use narrowly scoped correction instructions. If that focused correction returns a factual multi-sentence body without a headline, the backend can restore the already-safe first headline or derive one from the corrected body's first factual clause, then rerun every validator; numeric thousands separators are kept intact. A final punctuation-only quotation mismatch can be repaired deterministically by replacing only the validator-confirmed quote span with the exact source span; wording or structural mismatches are never repaired this way.

If quotation validation still fails, the response retains the latest safe generated candidate as an explicitly non-final draft and reports each affected source paragraph, original quotation, corresponding rewrite text when found, issue type, difference summary, and corrective action. The interface shows these details with `Retry Rewrite`. It never substitutes an old review or rewrite result.

## Public source retrieval safety

Public URL retrieval is server-side and bounded to reduce SSRF and resource-exhaustion risk:

- only HTTP or HTTPS URLs without embedded credentials are accepted;
- localhost, local/internal hostnames, non-public IPv4 and IPv6 ranges, and any hostname resolving to a non-public address are rejected;
- redirects are handled manually, limited, and DNS/public-address validation is repeated for every destination;
- cookies and other credentials are omitted from fetches;
- only HTML and plain-text media types are accepted;
- time, redirect, declared-size, streamed-byte, and extracted-text limits are enforced.

Retrieved pages remain untrusted input. The extractor removes common navigation, advertising, script, style, and related-content containers before creating the bounded source snapshot, but users must still verify the extracted facts.

## Local testing

Run the complete automated quality gate:

    npm test

Or run checks separately:

    npm run typecheck
    npm run lint
    npm run test:unit
    npm run build

The unit and component suites cover:

- text, public-URL, URL-only, and automatic English/Chinese language inference;
- empty, whitespace-only, at-limit, and over-limit inputs;
- public-address URL validation, redirects, timeouts, content types, byte limits, and source extraction, including tests for private/reserved DNS answers;
- six-category score bounds, strict review JSON, weighted-score recomputation, deterministic caps, findings, risks, and readiness bands;
- passing and failing reviews making one Review Agent call each with no rewrite;
- review score and feedback rendering without final output;
- explicit Rewrite Agent requests after both high and low scores;
- separate, explicit, and repeated Rewrite Agent calls;
- source-change invalidation, immediate stale-output clearing, request sequencing, and duplicate-submit prevention;
- rewrite-error handling without restoration of an older result;
- threshold/decision normalization;
- missing API configuration;
- API authentication and rate-limit failures;
- request timeout and network-safe errors;
- malformed, empty, and truncated AI responses;
- request content type, request JSON, and request-size limits;
- news-editor prompt structure, factual fidelity, language/script preservation, press-release-artifact removal, and untrusted-data boundaries;
- quotation classification, Unicode normalization, repeated/nested forms, modification, omission, splitting, merging, punctuation changes, one focused retry, and actionable retained-candidate errors;
- a deterministic bilingual review set with strong and poor Traditional Chinese and English copy, missing facts, unsupported claims, Chinese quotation styles, and the supplied Oriental Daily URL;
- a 12-case bilingual rewrite set spanning language/script preservation, mixed-language names, rough notes, promotional releases, quotations, dates, statistics, allegations, uncertainty, missing information, placeholders, contradictions, and prompt injection.

### Browser testing without a real API key

The bundled mock provider is for local QA only. Run it in one PowerShell window:

    cd "C:\AI\AI-Agent-News-Review-Rewrite"
    npm run mock:deepseek

Run the site in another window:

    cd "C:\AI\AI-Agent-News-Review-Rewrite"
    $env:DEEPSEEK_API_KEY="local-test-key"
    $env:DEEPSEEK_API_BASE_URL="http://127.0.0.1:4010"
    $env:DEEPSEEK_TIMEOUT_MS="1000"
    npm run dev

Useful mock inputs:

- A normal rough draft returns a low score and no rewrite.
- A draft containing `SIMULATE_PASS_REVIEW` returns a passing review and no rewrite.
- Clicking `Rewrite with AI` makes the only rewrite call and reveals the final-output panel.
- A draft containing `SIMULATE_REWRITE_FAILURE` returns a safe rewrite error while preserving review state.
- SIMULATE_AUTH_FAILURE returns an authentication error.
- SIMULATE_MALFORMED_REVIEW returns invalid Review Agent JSON.
- SIMULATE_TIMEOUT waits long enough to trigger the configured timeout.

The mock provider logs only the Review/Rewrite Agent call count, never draft content. Use browser responsive tools to check a desktop width around 1440 pixels and a mobile width around 390 pixels. Verify review-only rendering, both post-review actions, stale-review behavior, error retry, final-output gating, copy, repeated rewrite, and Start New Draft.

### Optional live model evaluations

The deterministic test suite is the default quality gate. Live evaluations require a running application, use the configured provider, may incur charges, and are not run by `npm test`.

Run the repeatable Review Agent scoring set:

    npm run eval:review:live

`EVAL_RUNS` defaults to 2 runs per case. `EVAL_IDS` selects a comma-separated subset, `EVAL_MODEL` records the non-secret model identifier used for the run, `REVIEW_EVAL_BASE_URL` changes the application URL, and `REVIEW_EVAL_TIMEOUT_MS` changes the per-request timeout. The JSON-lines output records case IDs, parameters, sub-scores, weighted and final scores, caps, bands, latency, parsing or HTTP errors, run spread, and bilingual strong-versus-poor separation. It never prints drafts, retrieved source text, credentials, rationales, or finding evidence.

Run the Rewrite Agent fidelity set:

    npm run eval:live

Set `LIVE_EVAL_IDS` to a comma-separated subset and `LIVE_EVAL_BASE_URL` when the site is not on `http://127.0.0.1:3000`. The harness counts every request and checks traceability, exact quotations, required terms, new numbers or placeholders, prohibited boilerplate, outlet attribution, markdown, and the headline/body format. It never prints credentials.

These commands provide a repeatable basis for before/after or Flash/Pro comparison. The earlier Flash baseline on 16 July 2026 used disabled thinking and a smaller output budget; it is historical evidence, not the current production configuration. Current runs record `deepseek-v4-pro`, enabled thinking, `reasoning_effort: max`, upstream streaming, and a 64,000-token completion budget. The rewrite harness exercises the production route and its bounded retry behavior. Provider outputs can still vary, so recorded results are not a permanent quality guarantee.

## Editorial research basis

The news-editor prompt uses only shared, high-level principles—accuracy, concise structure, close attribution, explicit uncertainty, and separation of reporting from promotion. It does not copy article wording or imitate an outlet's voice. Research reviewed:

- BBC [Accuracy editorial guidelines](https://downloads.bbc.co.uk/guidelines/editorialguidelines/pdfs/bbc-editorial-guidelines-section-3-accuracy.pdf), [Writing Concisely exercise](https://downloads.bbc.co.uk/academy/academyfiles/Writing_Concisely.pdf), and a [representative report](https://feeds.bbci.co.uk/news/articles/c7vlngvm6d7o)
- CNN Academy [Ethics in Journalism](https://academy.cnn.com/hub-course/ethics-in-journalism/) and [representative CNN Newsource reporting](https://kesq.com/news/national-politics/cnn-us-politics/2026/05/12/exclusive-cia-escalates-secret-war-on-cartels-with-deadly-operations-inside-mexico/)
- TVB News [representative Traditional Chinese report](https://news.tvb.com/tc/1177168-%E8%AD%A6%E6%96%B9%E6%89%93%E6%93%8A%E5%A4%96%E5%9C%8D%E8%B3%AD%E5%8D%9A%E7%93%A6%E8%A7%A3%E4%B8%80%E9%BB%91%E7%A4%BE%E6%9C%83%E6%93%8D%E6%8E%A7%E5%9C%98%E5%A4%A5%E7%B1%B2%E5%B8%82%E6%B0%91%E5%8B%BF%E5%8F%83%E8%88%87%E9%9D%9E%E6%B3%95%E8%B3%AD%E5%8D%9A)
- 東方日報 [representative Traditional Chinese report](https://orientaldaily.on.cc/content/%E8%A6%81%E8%81%9E%E6%B8%AF%E8%81%9E/odn-20260609-0609_00176_042/%E5%81%B7%E9%8C%A2%E5%85%BC%E6%B8%B8%E8%AA%AA%E9%8A%B7%E6%A1%88--%E9%AB%98%E7%B4%9A%E9%97%9C%E5%93%A1%E8%AA%8D3%E7%BD%AA)

## Input and data limits

- Drafts are limited to 50,000 characters.
- Public source URLs are limited to 2,048 characters and must resolve only to public internet addresses.
- Review requests accept a draft, a public source URL, or both; picture upload and user-supplied image-text fields are rejected.
- Public page retrieval defaults to an 8-second timeout, three redirects, and 1.5 MB of response bytes before bounded text extraction.
- API request bodies are limited to 220,000 bytes.
- The active article, review, and successful rewrite turns are stored only in tab-scoped browser `sessionStorage`; there is no server database or account-level history. Source changes and `Start New Draft` clear the stored session.
- Submitted copy and retrieved text are sent to DeepSeek for processing and are therefore subject to DeepSeek account terms and data handling.

## Troubleshooting

### The server says the API key is not configured

Confirm DEEPSEEK_API_KEY is set in .env.local and restart the server. Do not place the key in a NEXT_PUBLIC variable.

### DeepSeek rejects the credentials

Check that the key is active and copied without surrounding quotation marks. The site reports this as DEEPSEEK_AUTH_ERROR without exposing provider details.

### The request times out

Retry with a shorter draft or check DeepSeek service availability. Maximum-effort Pro requests stream upstream and may legitimately take several minutes; the default timeout is the provider's documented ten-minute queue window, and the interface shows live elapsed time while it waits.

### The model is rejected

Use a model identifier currently available to your DeepSeek account. The verified project default is `deepseek-v4-pro`. A rejected model now reports the workflow stage, provider, configured model, upstream HTTP status, and a sanitized cause without exposing credentials or provider reasoning.

### The Review Agent returns invalid JSON

Retry the request. JSON Output is enabled, but the backend still validates every field and fails safely if output is malformed, empty, or truncated.

### A source URL is rejected

Only public HTTP or HTTPS article pages without embedded credentials are supported. Localhost, private/internal destinations, unsafe redirects, unsupported media types, oversized pages, and pages that exceed the retrieval timeout are rejected rather than fetched permissively. Paste the article text directly if a public site blocks bounded server-side retrieval.

### Quotation preservation still fails after retry

The backend has already used its single focused correction attempt. Review the displayed paragraph, original quotation, candidate quotation, difference, and suggested action. The retained candidate is diagnostic and is not marked final; use `Retry Rewrite` to start a new explicit request after checking the source quotation.

### A hydration warning mentions data-sharkid

`data-sharkid` is injected into form controls by the Surfshark browser extension's Alternative ID autofill feature before React hydrates the page. It is not generated by this application or included in the server HTML. Disable Surfshark Alternative ID automatic form filling for localhost, disable the extension, or use a private/clean browser profile where the extension is not enabled. Do not add `suppressHydrationWarning`; it would only hide the external DOM mutation.

### Copy does not work

Clipboard access can be restricted outside localhost or HTTPS. Select the final-output textarea and copy manually if the browser denies permission.

### Port 3000 is already in use

    $env:PORT="3001"
    npm run dev

Then open [http://localhost:3001](http://localhost:3001).

## Remaining operational limitations

A live DeepSeek success request requires a user-supplied API key and may incur provider charges. Some public sites may block or render content in a way that prevents bounded server-side extraction.

Hostname addresses are checked before each fetch and redirect, but native `fetch` performs its own subsequent DNS resolution; the validated address is not pinned to the connection. A hostile domain could therefore attempt DNS rebinding in that time-of-check/time-of-use window. Use a resolver-pinning egress proxy before treating public-URL retrieval as a hardened fetcher for fully adversarial URLs.

DeepSeek V4 is text-only in this workflow, so the application does not offer picture upload, visual analysis, or user-supplied image OCR/caption inputs. Quotation classification, Chinese person-name extraction, and named-speaker proximity detection are deliberately conservative heuristics, and provider output remains probabilistic. Deterministic checks cover exact quotations, high-confidence named attribution beside them, extracted source-script names, figures, mixed-language terms, format, and output language, but a human editor must still verify full semantic fidelity, ambiguous or indirect attribution, units, and publication readiness.
