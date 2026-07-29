# Accounts, authentication, and Cloudflare deployment

This document covers the protected review/rewrite application and the
employee-only account approval portal. The future public published-content
website is intentionally outside this implementation.

## Architecture

- The existing Next.js App Router application remains the frontend and API
  surface.
- `@opennextjs/cloudflare` packages the application as a Cloudflare Worker.
- Cloudflare D1 stores account requests, users, password setup tokens,
  sessions, decision audits, login-rate buckets, and email-delivery metadata.
- Authentication uses opaque random session IDs in `HttpOnly` cookies. Only
  SHA-256 hashes of session IDs and setup tokens are stored.
- Passwords use Web Crypto PBKDF2-HMAC-SHA-256 with a random 16-byte salt and
  600,000 iterations. Plaintext passwords are never stored or logged.
- Mutating authenticated routes require both a same-origin request and a
  double-submit CSRF value bound to the server-side session.
- Page guards redirect unauthenticated visitors to `/login`; API guards return
  `401`. Employee routes also enforce the `employee` role and return `403` to a
  client.
- Login attempts use secret-HMACed email/IP and IP-only fixed-window D1
  buckets. The session created after login or password setup is new, so an
  earlier session identifier cannot be fixed into the authenticated session.
- Protected pages and logout responses use no-store/cache-clearing controls.

The D1 binding name is `DB`. The initial schema is
[`migrations/0001_authentication.sql`](../migrations/0001_authentication.sql).
Times are stored as Unix seconds in UTC.

## Account lifecycle

1. An applicant submits all six fields at `/request-account`. Zod validation
   runs in the browser for feedback and again on the Worker as the authority.
2. D1 creates a `pending` request after checking both pending requests and
   existing users for the normalized email.
3. The employee notification links to `/employee/requests/:id`.
4. An employee can reject with an optional reason, or approve. Approval creates
   a `setup_pending` client and a random, single-use setup token.
5. The raw setup token appears only in the delivered URL fragment
   (`/setup-password#token=...`). Browsers do not include fragments in HTTP
   requests; the setup page removes it from the address bar before validation.
   D1 stores only its hash.
6. Successful password setup atomically consumes the token, activates the
   client, invalidates other outstanding setup tokens, creates a new session,
   and redirects to the review workspace.
7. Logout revokes the D1 session, expires both cookies, requests cache clearing,
   and redirects to `/login`.

## Local setup

Prerequisites are Node.js 22.13 or later and npm.

```powershell
npm install
Copy-Item .env.example .env.local
Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Open `http://localhost:3000`. `next.config.ts` initializes the OpenNext
Cloudflare development context, so Next development uses the local Wrangler D1
database.

To exercise the built Worker locally:

```powershell
npm run preview
```

The OpenNext preview normally listens on `http://localhost:8787` and reads the
ignored `.dev.vars` file. On Windows, OpenNext recommends WSL for the closest
production parity.

### Development email

Keep `EMAIL_DELIVERY_MODE=preview` locally. No external message is sent and
email bodies or raw setup tokens are not written to the terminal. Delivery
metadata is stored in D1. After an employee approves a request, the
development-only setup URL appears on that protected employee detail page.
Preview mode is rejected when `APP_ENV=production`.

## Create the first employee

Run the interactive helper. It asks for the password in a hidden TTY prompt, so
the password is not placed in command history or a process argument.

```powershell
npm run employee:prepare -- --email employee@example.com --name "Employee Name" --local
npx wrangler d1 execute pressready-auth --local --file ".wrangler\bootstrap\create-employee.sql"
Remove-Item -LiteralPath ".wrangler\bootstrap\create-employee.sql"
```

The generated SQL contains a password hash and is ignored by Git. Delete it
immediately after Wrangler succeeds. The helper refuses to overwrite an
existing bootstrap SQL file.

For production, use `--remote` in both the prepare and D1 execute commands:

```powershell
npm run employee:prepare -- --email employee@example.com --name "Employee Name" --remote
npx wrangler d1 execute pressready-auth --remote --file ".wrangler\bootstrap\create-employee.sql"
Remove-Item -LiteralPath ".wrangler\bootstrap\create-employee.sql"
```

## Environment variables and secrets

| Name | Required | Purpose |
| --- | --- | --- |
| `APP_ENV` | Production | Set to `production` on the deployed Worker. |
| `PUBLIC_APP_URL` | Production | Canonical HTTPS origin used in email links. |
| `AUTH_SECRET` | Production secret | Random value of at least 32 characters for HMACed rate-limit identifiers. |
| `SESSION_TTL_SECONDS` | Optional | Absolute session lifetime; default 43,200 seconds. |
| `PASSWORD_SETUP_TTL_SECONDS` | Optional | Setup-link lifetime; default 86,400 seconds. |
| `ACCOUNT_APPROVAL_NOTIFICATION_EMAIL` | Production | Employee inbox for new requests. |
| `EMAIL_FROM_ADDRESS` | HTTP email mode | Verified sender address. |
| `EMAIL_FROM_NAME` | Optional | Sender display name; default `PressReady`. |
| `EMAIL_DELIVERY_MODE` | Production | Set to `http`; local development uses `preview`. |
| `EMAIL_PROVIDER_API_URL` | HTTP email mode | HTTPS endpoint accepting the envelope below. |
| `EMAIL_PROVIDER_API_KEY` | Production secret | Credential for the email endpoint. |
| `EMAIL_PROVIDER_AUTH_HEADER` | Optional | Authentication header; default `Authorization`. |
| `EMAIL_PROVIDER_AUTH_SCHEME` | Optional | Authentication scheme; default `Bearer`. Use an empty value for a raw key. |
| `XAI_API_KEY` | As used, secret | Existing xAI review/rewrite credential. |
| `DEEPSEEK_API_KEY` | As used, secret | Existing DeepSeek review/rewrite credential. |
| `AI_MODEL` | Optional | Existing review/rewrite model selection. |

`.env.example` is the full template for Next development.
`.dev.vars.example` is the Worker-preview template. Neither contains real
credentials.

## Email provider adapter

No provider is hard-coded. In `http` mode the Worker sends a `POST` request to
`EMAIL_PROVIDER_API_URL` with the configured authorization header and this JSON
shape:

```json
{
  "from": { "email": "no-reply@example.com", "name": "PressReady" },
  "to": [{ "email": "recipient@example.com" }],
  "subject": "Message subject",
  "text": "Plain-text body",
  "html": "<p>HTML body</p>",
  "metadata": { "messageType": "new_request | approved_setup | rejected" }
}
```

The endpoint may return `{ "id": "..." }` or `{ "messageId": "..." }`; both are
optional. Point the adapter at an internal email gateway or provider endpoint
that accepts this envelope. If a provider requires another payload, change only
`lib/server/auth/email.ts`, keeping provider credentials in Worker secrets.

Email delivery failure is recorded without exposing the response body or
credential. Approval/rejection remains auditable, and an employee can resend a
setup email while the client is still in `setup_pending`.

## Cloudflare deployment

1. Authenticate Wrangler and create the production D1 database:

   ```powershell
   npx wrangler login
   npx wrangler d1 create pressready-auth
   ```

2. Replace the all-zero `database_id` placeholder in `wrangler.jsonc` with the
   returned D1 ID. Do not change the `DB` binding unless the application code
   and generated types are changed together.

3. Configure non-secret Worker variables in `wrangler.jsonc` or the Cloudflare
   dashboard: `APP_ENV=production`, the HTTPS `PUBLIC_APP_URL`, lifetimes,
   sender identity, notification address, provider endpoint, and
   `EMAIL_DELIVERY_MODE=http`.

4. Configure secrets without committing them:

   ```powershell
   npx wrangler secret put AUTH_SECRET
   npx wrangler secret put EMAIL_PROVIDER_API_KEY
   npx wrangler secret put XAI_API_KEY
   npx wrangler secret put DEEPSEEK_API_KEY
   ```

   Only add the AI-provider secrets that the deployment uses.

5. Apply migrations and create the initial employee:

   ```powershell
   npm run db:migrate:remote
   npm run employee:prepare -- --email employee@example.com --name "Employee Name" --remote
   npx wrangler d1 execute pressready-auth --remote --file ".wrangler\bootstrap\create-employee.sql"
   Remove-Item -LiteralPath ".wrangler\bootstrap\create-employee.sql"
   ```

6. Build and deploy:

   ```powershell
   npm run deploy
   ```

7. Verify production cookies are `Secure`, the canonical URL is HTTPS, email
   delivery is not in preview mode, `/api/review` returns `401` without a
   session, and a client receives `403` from `/api/employee/account-requests`.

## Verification

Run the complete local verification:

```powershell
npm run typecheck
npm run lint
npm run test:unit
npm run build
npx opennextjs-cloudflare build
npm audit --omit=dev
```

`tests/auth-workflows.test.ts` runs against an actual Miniflare D1 binding and
the migration SQL. It covers:

- successful, invalid, pending-duplicate, and active-account-duplicate requests;
- employee pending-list access and client `403`;
- approval, audit recording, setup-token validation, password mismatch,
  automatic session creation, token reuse, and expiry;
- rejection, optional reason/audit display, and pending/rejected login denial;
- generic incorrect-password handling, unauthenticated API `401`, CSRF `403`,
  logout invalidation, and post-logout `401`;
- repeated-login throttling and absolute session expiry.
- HTML escaping for applicant data and rejection reasons in all relevant email
  templates.

The existing editorial review/rewrite suites continue to run in the same test
command. Route tests mock only the authentication boundary so editorial
behavior remains isolated; the authentication suite exercises the real guards.

## Current limitations and next steps

- D1 fixed-window rate limiting is a practical application-layer control, but a
  high-risk public deployment should also add Cloudflare WAF rate-limit rules
  and optionally Turnstile to the public request/login forms.
- The employee portal is protected by application RBAC. Cloudflare Access can
  be added as defense in depth for employee routes without replacing RBAC.
- The generic HTTP email endpoint still needs a configured provider or gateway
  and verified sender domain before production delivery works.
- This stage intentionally has no password-reset or account-settings UI.
- Session expiry is absolute; rotating/idle session policies can be added if
  required by organisational policy.
- The public published-content website remains a separate future system.
