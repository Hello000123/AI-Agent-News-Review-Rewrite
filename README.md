# PressReady — AI News Draft Review and Rewrite

PressReady is a focused local website for one workflow:

    Draft input → Review Agent → Score and feedback → Edit yourself or request Rewrite Agent → Final news report

The Review Agent scores a draft once and returns the complete structured review immediately. Rewriting never starts automatically. After every review, the user can edit the populated draft or explicitly ask the Rewrite Agent to turn the immutable reviewed version into a publication-quality news report.

The project is intentionally limited to this workflow. It has no login, database, user history, news search, language switcher, dark theme, publishing, distribution, or scheduled work.

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
      review-summary.tsx           Scores and written feedback
      output-panel.tsx              Final output and actions
    lib/
      client/api.ts             Safe browser-to-backend requests
      server/agents/            DeepSeek client, prompts, agents, workflow
      server/config.ts          Environment configuration
      server/errors.ts          Safe typed errors
      server/http.ts            Request limits and error responses
      shared/contracts.ts       Shared Zod contracts and TypeScript types
    tests/
      fixtures/                 Valid review fixtures
      *.test.ts                 Unit and API validation tests
      mock-deepseek-server.mjs  Local browser-test provider
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
| DEEPSEEK_MODEL | deepseek-v4-flash | Model used by both agents |
| REVIEW_PASS_SCORE | 80 | Overall score used to label a review as passing |

Optional server settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| DEEPSEEK_API_BASE_URL | https://api.deepseek.com | DeepSeek base URL; useful for isolated mock testing |
| DEEPSEEK_TIMEOUT_MS | 90000 | Abort timeout in milliseconds, from 1,000 to 600,000 |

Invalid pass scores fall back to 80. Invalid timeouts fall back to 90 seconds. Restart the development server after changing environment variables.

## DeepSeek API configuration

As of July 13, 2026, the official OpenAI-compatible endpoint is:

    POST https://api.deepseek.com/chat/completions

The example configuration uses deepseek-v4-flash, the current faster and more economical V4 model. Set DEEPSEEK_MODEL=deepseek-v4-pro when maximum writing quality is more important than latency and cost. The retired-soon legacy aliases deepseek-chat and deepseek-reasoner are deliberately not used.

Both calls explicitly disable thinking mode for predictable latency:

    thinking: { "type": "disabled" }

The review call enables JSON Output and validates the result with a strict schema. The rewrite call requests normal text. The server rejects empty, truncated, malformed, or incomplete provider responses.

Official references:

- [DeepSeek quick start](https://api-docs.deepseek.com/)
- [Chat Completions reference](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Models and pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [JSON Output guide](https://api-docs.deepseek.com/guides/json_mode/)
- [Error codes](https://api-docs.deepseek.com/quick_start/error_codes/)

## Development

    npm run dev

Open [http://localhost:3000](http://localhost:3000).

The browser sends drafts only to the local Next.js backend. The backend calls DeepSeek with the secret key. The key is never included in browser source, browser requests, API error bodies, or application logs.

## Production build

    npm run build
    npm run start

The production server also starts at [http://localhost:3000](http://localhost:3000) unless PORT is set.

## Score-first review and decision logic

REVIEW_PASS_SCORE defaults to 80.

- `/api/review` invokes only the Review Agent, exactly once, for both passing and failing drafts.
- Every valid result immediately shows the score, category rationale, strengths, problems, missing information, recommendations, and the actions `Rewrite with AI` and `Edit draft myself`.
- `Rewrite with AI` separately calls `/api/rewrite` with the immutable reviewed draft and its matching validated review.
- `Edit draft myself` only focuses the populated editor. It makes no AI request and keeps the latest review visible.
- Once the draft changes, the review is marked as applying to an earlier version. AI rewriting stays disabled until the edited draft is reviewed again.
- The final-output panel appears only after a successful, explicit AI rewrite request. A rewrite error preserves the draft, review, feedback, and both actions.

The Review Agent returns PASS or REWRITE_REQUIRED, but the backend recalculates both the authoritative weighted overall score and the decision. The weighting is:

- content and core-announcement completeness: 40% (25% factual consistency and 15% completeness);
- clarity and readability: 20%;
- structure and organisation: 20%;
- professional tone: 15%;
- grammar and mechanics: 5%.

The backend rounds the weighted result to the nearest whole number, then compares it with REVIEW_PASS_SCORE. This prevents model arithmetic or a contradictory decision from changing the configured workflow.

## Agent behavior

The Review Agent:

- evaluates without rewriting;
- scores content, clarity, structure, tone, and writing mechanics using fixed weights and published score bands;
- distinguishes intrinsic writing quality from the work needed to convert source material into a news report;
- applies equivalent standards across languages and ignores publisher reputation;
- treats media contacts, boilerplates, executive quotations, formal datelines, and calls to action as optional unless essential to the specific announcement;
- returns a required rationale for every category score, plus strengths, problems, missing information, and recommendations;
- uses temperature 0 for the most repeatable scoring the configured provider can offer;
- returns strict JSON only.

The Rewrite Agent:

- receives the original draft plus validated review feedback;
- treats the original draft as the factual source of truth and feedback only as editing guidance;
- creates a concise factual headline, strong lead, inverted-pyramid structure, short paragraphs, and neutral newsroom language;
- preserves material supported facts, exact direct quotations, names, dates, numbers, attribution, uncertainty, language, and script;
- never invents facts, translations, context, causal links, quotations, or placeholders;
- removes promotional repetition and press-release artifacts without dropping material facts;
- returns only a headline, one blank line, and the news-report body.

User drafts and feedback are wrapped as JSON data in the prompts and explicitly treated as untrusted content. Generated output is rendered as plain textarea text; HTML is never injected.

## Local testing

Run the complete automated quality gate:

    npm test

Or run checks separately:

    npm run typecheck
    npm run lint
    npm run test:unit
    npm run build

The unit and component suites cover:

- empty, whitespace-only, very short, at-limit, and over-limit drafts;
- score bounds and strict review JSON;
- passing and failing reviews making one Review Agent call each with no rewrite;
- review score and feedback rendering without final output;
- both post-review actions for every result;
- separate, explicit, and repeated Rewrite Agent calls;
- edit-without-AI behavior and sticky stale-review invalidation;
- rewrite-error state preservation and duplicate-submit prevention;
- threshold/decision normalization;
- missing API configuration;
- API authentication and rate-limit failures;
- request timeout and network-safe errors;
- malformed, empty, and truncated AI responses;
- request content type, request JSON, and request-size limits;
- news-editor prompt structure, factual fidelity, language/script preservation, press-release-artifact removal, and untrusted-data boundaries;
- a 12-case bilingual evaluation set spanning English, Traditional Chinese, Simplified Chinese script preservation, mixed-language names, rough notes, promotional releases, quotations, dates, statistics, allegations, uncertainty, missing information, placeholders, contradictions, and prompt injection.

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

### Optional live rewrite evaluation

The deterministic test suite is the default quality gate. To evaluate the same made-up bilingual fixtures against the configured live model, start the application and run:

    npm run eval:live

Set `LIVE_EVAL_IDS` to a comma-separated subset for staged batches and `LIVE_EVAL_BASE_URL` when the site is not on `http://127.0.0.1:3000`. The harness counts every request and checks traceability, exact quotations, required terms, new numbers/placeholders, prohibited boilerplate, outlet attribution, markdown, and the headline/body format. It never prints credentials.

## Editorial research basis

The news-editor prompt uses only shared, high-level principles—accuracy, concise structure, close attribution, explicit uncertainty, and separation of reporting from promotion. It does not copy article wording or imitate an outlet's voice. Research reviewed:

- BBC [Accuracy editorial guidelines](https://downloads.bbc.co.uk/guidelines/editorialguidelines/pdfs/bbc-editorial-guidelines-section-3-accuracy.pdf), [Writing Concisely exercise](https://downloads.bbc.co.uk/academy/academyfiles/Writing_Concisely.pdf), and a [representative report](https://feeds.bbci.co.uk/news/articles/c7vlngvm6d7o)
- CNN Academy [Ethics in Journalism](https://academy.cnn.com/hub-course/ethics-in-journalism/) and [representative CNN Newsource reporting](https://kesq.com/news/national-politics/cnn-us-politics/2026/05/12/exclusive-cia-escalates-secret-war-on-cartels-with-deadly-operations-inside-mexico/)
- TVB News [representative Traditional Chinese report](https://news.tvb.com/tc/1177168-%E8%AD%A6%E6%96%B9%E6%89%93%E6%93%8A%E5%A4%96%E5%9C%8D%E8%B3%AD%E5%8D%9A%E7%93%A6%E8%A7%A3%E4%B8%80%E9%BB%91%E7%A4%BE%E6%9C%83%E6%93%8D%E6%8E%A7%E5%9C%98%E5%A4%A5%E7%B1%B2%E5%B8%82%E6%B0%91%E5%8B%BF%E5%8F%83%E8%88%87%E9%9D%9E%E6%B3%95%E8%B3%AD%E5%8D%9A)
- 東方日報 [representative Traditional Chinese report](https://orientaldaily.on.cc/content/%E8%A6%81%E8%81%9E%E6%B8%AF%E8%81%9E/odn-20260609-0609_00176_042/%E5%81%B7%E9%8C%A2%E5%85%BC%E6%B8%B8%E8%AA%AA%E9%8A%B7%E6%A1%88--%E9%AB%98%E7%B4%9A%E9%97%9C%E5%93%A1%E8%AA%8D3%E7%BD%AA)

## Input and data limits

- Drafts are limited to 50,000 characters.
- API request bodies are limited to 220,000 bytes.
- The application does not persist drafts, results, or user history.
- Live drafts are sent to DeepSeek for processing and are therefore subject to DeepSeek account terms and data handling.

## Troubleshooting

### The server says the API key is not configured

Confirm DEEPSEEK_API_KEY is set in .env.local and restart the server. Do not place the key in a NEXT_PUBLIC variable.

### DeepSeek rejects the credentials

Check that the key is active and copied without surrounding quotation marks. The site reports this as DEEPSEEK_AUTH_ERROR without exposing provider details.

### The request times out

Retry with a shorter draft, check DeepSeek service availability, or increase DEEPSEEK_TIMEOUT_MS. A longer timeout may make the interface wait longer during provider congestion.

### The model is rejected

Use a currently available model such as deepseek-v4-flash or deepseek-v4-pro. Restart after changing DEEPSEEK_MODEL.

### The Review Agent returns invalid JSON

Retry the request. JSON Output is enabled, but the backend still validates every field and fails safely if output is malformed, empty, or truncated.

### A hydration warning mentions data-sharkid

`data-sharkid` is injected into form controls by the Surfshark browser extension's Alternative ID autofill feature before React hydrates the page. It is not generated by this application or included in the server HTML. Disable Surfshark Alternative ID automatic form filling for localhost, disable the extension, or use a private/clean browser profile where the extension is not enabled. Do not add `suppressHydrationWarning`; it would only hide the external DOM mutation.

### Copy does not work

Clipboard access can be restricted outside localhost or HTTPS. Select the final-output textarea and copy manually if the browser denies permission.

### Port 3000 is already in use

    $env:PORT="3001"
    npm run dev

Then open [http://localhost:3001](http://localhost:3001).

## Remaining operational limitation

A live DeepSeek success request requires a user-supplied API key and may incur provider charges. The project includes deterministic mocked tests so the workflow can be tested without a real credential.
