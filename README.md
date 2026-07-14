# PressReady — Simplified AI Press Release Reviewer

PressReady is a focused local website for one workflow:

    Draft input → Review Agent → Optional or automatic Rewrite Agent → Final output

The Review Agent scores a draft and returns structured feedback. A score below the configured threshold triggers an automatic rewrite. A passing draft remains unchanged and can still be rewritten on request.

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
      api/review/route.ts       Review and automatic-rewrite endpoint
      api/rewrite/route.ts      Manual/repeated rewrite endpoint
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

    cd "C:\AI\SimpleWebsite"
    npm install
    Copy-Item .env.example .env.local

Open .env.local and add the API key. Never commit that file.

## Environment variables

Required:

| Variable | Example | Purpose |
| --- | --- | --- |
| DEEPSEEK_API_KEY | your-key | Server-only DeepSeek credential |
| DEEPSEEK_MODEL | deepseek-v4-flash | Model used by both agents |
| REVIEW_PASS_SCORE | 80 | Overall score that passes without an automatic rewrite |

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

## Review threshold and decision logic

REVIEW_PASS_SCORE defaults to 80.

- overallScore below the threshold: the backend automatically calls the Rewrite Agent.
- overallScore at or above the threshold: the original draft is the recommended output and no rewrite is made.
- A passing draft exposes Rewrite Anyway.
- Every result exposes Rewrite Again.

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
- distinguishes intrinsic writing quality from the work needed to convert news or analysis into a press release;
- applies equivalent standards across languages and ignores publisher reputation;
- treats media contacts, boilerplates, executive quotations, formal datelines, and calls to action as optional unless essential to the specific announcement;
- returns a required rationale for every category score, plus strengths, problems, missing information, and recommendations;
- uses temperature 0 for the most repeatable scoring the configured provider can offer;
- returns strict JSON only.

The Rewrite Agent:

- receives the original draft plus validated review feedback;
- corrects language, structure, tone, readability, and repetition;
- preserves supported facts;
- uses bracketed placeholders for missing facts;
- returns only a complete press release.

User drafts and feedback are wrapped as JSON data in the prompts and explicitly treated as untrusted content. Generated output is rendered as plain textarea text; HTML is never injected.

## Local testing

Run the complete automated quality gate:

    npm test

Or run checks separately:

    npm run typecheck
    npm run lint
    npm run test:unit
    npm run build

The unit suite covers:

- empty, whitespace-only, very short, at-limit, and over-limit drafts;
- score bounds and strict review JSON;
- low-score automatic rewriting;
- high-score pass without rewriting;
- manual and repeated rewrites;
- threshold/decision normalization;
- missing API configuration;
- API authentication and rate-limit failures;
- request timeout and network-safe errors;
- malformed, empty, and truncated AI responses;
- request content type, request JSON, and request-size limits;
- agent prompt requirements and untrusted-data boundaries.

### Browser testing without a real API key

The bundled mock provider is for local QA only. Run it in one PowerShell window:

    cd "C:\AI\SimpleWebsite"
    npm run mock:deepseek

Run the site in another window:

    cd "C:\AI\SimpleWebsite"
    $env:DEEPSEEK_API_KEY="local-test-key"
    $env:DEEPSEEK_API_BASE_URL="http://127.0.0.1:4010"
    $env:DEEPSEEK_TIMEOUT_MS="1000"
    npm run dev

Useful mock inputs:

- A normal rough draft returns a low score and automatic rewrite.
- A draft containing FOR IMMEDIATE RELEASE returns a passing review.
- SIMULATE_AUTH_FAILURE returns an authentication error.
- SIMULATE_MALFORMED_REVIEW returns invalid Review Agent JSON.
- SIMULATE_TIMEOUT waits long enough to trigger the configured timeout.

Use browser responsive tools to check a desktop width around 1440 pixels and a mobile width around 390 pixels. Verify Copy to Clipboard, Rewrite Anyway, Rewrite Again, Edit Input, and Start New Draft.

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
