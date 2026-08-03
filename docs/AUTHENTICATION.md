# Accounts, authentication, and Cloudflare deployment

This document covers the protected review/rewrite application and the
employee-only Admin Panel. The future public published-content
website is intentionally outside this implementation.

## Architecture

- The existing Next.js App Router application remains the frontend and API
  surface.
- `@opennextjs/cloudflare` packages the application as a Cloudflare Worker.
- Cloudflare D1 stores account requests, users, password setup tokens,
  sessions, approval/removal audits, login-rate buckets, and email-delivery
  metadata.
- A private Cloudflare R2 bucket stores optional account supporting documents
  under opaque object keys. D1 stores only the attachment metadata and
  ownership link. The Worker exposes the bytes only after an employee-role
  authorization check.
- Authentication uses opaque random session IDs in `HttpOnly` cookies. Only
  SHA-256 hashes of session IDs and setup tokens are stored.
- Passwords use scrypt with a random 16-byte salt (`N=32768`, `r=8`, `p=3`).
  The browser or employee-creation CLI performs the memory-hard derivation.
  The Worker stores only a versioned HMAC-SHA-256 of that derived proof, bound
  to the user ID, derivation parameters, and a server-only `PASSWORD_PEPPER`.
  A D1 copy therefore does not contain a proof that can be replayed at login.
  Existing scrypt and PBKDF2 records are wrapped into the peppered format
  without reducing their original work factor. Plaintext passwords and
  reusable client proofs are never stored or logged.
- Mutating authenticated routes require both a same-origin request and a
  double-submit CSRF value bound to the server-side session.
- Page guards redirect unauthenticated visitors to `/login`; API guards return
  `401`. Employee routes also enforce the `employee` role and return `403` to a
  client.
- Login attempts use secret-HMACed email/IP and IP-only fixed-window D1
  buckets. The session created after login or password setup is new, so an
  earlier session identifier cannot be fixed into the authenticated session.
- Protected pages and logout responses use no-store/cache-clearing controls.

The D1 binding name is `DB`. The schema starts in
[`migrations/0001_authentication.sql`](../migrations/0001_authentication.sql).
[`migrations/0002_account_request_optional_fields.sql`](../migrations/0002_account_request_optional_fields.sql)
preserves existing requests while making organisation fields nullable and
adding the nullable administrator message.
[`migrations/0003_client_account_removals.sql`](../migrations/0003_client_account_removals.sql)
adds immutable client-removal audit records without changing or deleting any
existing user.
[`migrations/0004_account_request_attachments.sql`](../migrations/0004_account_request_attachments.sql)
adds the D1 metadata and ownership table for private R2 account documents.
Times are stored as Unix seconds in UTC.

### Hosted-runtime password compatibility

Two hosted-only limits caused the intermittent login failure:

1. The original 600,000-iteration Web Crypto PBKDF2 call exceeded the hosted
   Worker's PBKDF2 ceiling even though Node and local Miniflare accepted it.
2. Moving the same request path to strong scrypt preserved storage security,
   but Cloudflare Free terminates requests after 10 ms of CPU. A selected
   scrypt derivation takes about 136 ms on the development machine. Hosted
   traces therefore ended with `outcome: exceededCpu` and Cloudflare Error
   1102/HTTP 503 before application error handling could return a JSON 401.

Login now starts with a same-origin challenge that returns only the account's
salt and public derivation parameters (or indistinguishable deterministic fake
values for an unknown email). The browser derives the proof, then the Worker
validates the raw password policy and performs only a constant-time,
server-peppered HMAC comparison. Password setup uses the same design. This
keeps the existing scrypt work factor, avoids a paid-only Worker CPU setting,
and returns normal user-safe 401 responses for incorrect or unknown accounts.

## Account lifecycle

1. An applicant submits their name, email address, and phone number at
   `/request-account`. Company/organisation, department, job title, and a
   1,000-character message to the administrator are optional. An applicant may
   also attach one PDF, DOCX, PPTX, XLSX, PNG, JPEG, or WebP file up to 10 MB.
   File extension, declared MIME type, and content signature are validated by
   the browser and Worker. Zod validation runs in the browser for feedback and
   again on the Worker as the authority.
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
8. The Admin Panel separates approvals, client accounts, and employee accounts.
   Removing a client deactivates the user, clears the password hash, revokes all
   sessions, invalidates unused setup tokens, stores an audit record, and sends
   the administrator's message to the client. Employee removal is not exposed.

Client applications do not require or expose email verification codes, links,
resend actions, or timers. Manual employee approval remains the verification
boundary before a client can set a password.

Passwords are valid when they contain 9–63 printable English keyboard
characters. Letters-only passwords and passwords without numbers or symbols
are valid; no character-category combination is required. This input policy
does not change the scrypt password-storage parameters.

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

Run the interactive command. It asks for email address, full name, password,
and password confirmation in that order. Password input is visible in the
terminal but is never placed in a process argument, printed after creation, or
written as plaintext. The command checks for duplicates, hashes the password,
and applies the insert itself.

```powershell
npm run create-employee
# Equivalent explicit target:
npm run create-employee:local
```

Local D1 is the safe default. A temporary SQL file containing only a password
hash is created outside the repository for the Wrangler operation and removed
automatically.

For production, select Cloudflare D1 explicitly:

```powershell
npm run create-employee:remote
```

The npm scripts pass `--local` or `--remote` directly to the program instead of
depending on forwarded npm options. Set `AUTH_D1_DATABASE_NAME` only if the
configured D1 database is not named `pressready-auth`. Apply local or remote
migrations before creating the employee. Any validation, duplicate, Wrangler,
or D1 failure exits with a non-zero status.

## Environment variables and secrets

| Name | Required | Purpose |
| --- | --- | --- |
| `APP_ENV` | Production | Set to `production` on the deployed Worker. |
| `PUBLIC_APP_URL` | Production | Canonical HTTPS origin used in email links. |
| `AUTH_SECRET` | Production secret | Random value of at least 32 characters for HMACed rate-limit identifiers. |
| `PASSWORD_PEPPER` | Production secret | Separate stable random value of at least 32 characters used to protect derived password proofs. Changing it requires password setup again. Falls back to `AUTH_SECRET` only for compatibility. |
| `SESSION_TTL_SECONDS` | Optional | Absolute session lifetime; default 43,200 seconds. |
| `PASSWORD_SETUP_TTL_SECONDS` | Optional | Setup-link lifetime; default 86,400 seconds. |
| `ACCOUNT_APPROVAL_NOTIFICATION_EMAIL` | Production | Employee inbox for new requests. |
| `EMAIL_FROM_ADDRESS` | HTTP email mode | Resend sender address. Use `onboarding@resend.dev` only for a domain-free test, or an address on a verified sending domain for normal delivery. |
| `EMAIL_FROM_NAME` | Optional | Sender display name; default `PressReady`. |
| `EMAIL_DELIVERY_MODE` | Production | Set to `http`; local development uses `preview`. |
| `EMAIL_PROVIDER_API_URL` | HTTP email mode | Resend email endpoint, normally `https://api.resend.com/emails`. |
| `EMAIL_PROVIDER_API_KEY` | Production secret | Resend API key with sending access. |
| `EMAIL_PROVIDER_AUTH_HEADER` | Optional | Authentication header; default `Authorization`. |
| `EMAIL_PROVIDER_AUTH_SCHEME` | Optional | Authentication scheme; Resend uses `Bearer`. |
| `XAI_API_KEY` | As used, secret | Existing xAI review/rewrite credential. |
| `DEEPSEEK_API_KEY` | As used, secret | Existing DeepSeek review/rewrite credential. |
| `AI_MODEL` | Optional | Existing review/rewrite model selection. |

`.env.example` is the full template for Next development.
`.dev.vars.example` is the Worker-preview template. Neither contains real
credentials.

## Resend email adapter

In `http` mode the Worker sends a `POST` request to the Resend email API using
the configured authorization header and this JSON shape:

```json
{
  "from": "PressReady <no-reply@example.com>",
  "to": ["recipient@example.com"],
  "subject": "Message subject",
  "text": "Plain-text body",
  "html": "<p>HTML body</p>",
  "tags": [
    {
      "name": "message_type",
      "value": "new_request | approved_setup | rejected | client_removed"
    }
  ]
}
```

Resend returns `{ "id": "..." }` after accepting a message. The adapter records
that identifier but never exposes the API key or the provider response body.
The request uses manual redirect handling because Workerd does not implement
`redirect: "error"`; any 3xx response is treated as a delivery failure, so the
provider authorization header is never forwarded to another origin.

For a domain-free integration test, use `onboarding@resend.dev` as the sender
and the email address associated with the Resend account as the recipient.
This restriction means the first employee login email must differ from the
test applicant email if the complete approval and password-setup workflow is
being exercised. For delivery to arbitrary recipients, verify a sending domain
in Resend and change `EMAIL_FROM_ADDRESS` to an address on that domain.

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

3. Create the private account-document R2 bucket declared in `wrangler.jsonc`:

   ```powershell
   npx wrangler r2 bucket create pressready-account-documents
   ```

   Keep the `ACCOUNT_DOCUMENTS` binding private to this Worker. Do not attach a
   public development URL or custom domain to the bucket.

4. Configure non-secret Worker variables in `wrangler.jsonc` or the Cloudflare
   dashboard: `APP_ENV=production`, the HTTPS `PUBLIC_APP_URL`, lifetimes,
   Resend sender identity, notification address,
   `EMAIL_PROVIDER_API_URL=https://api.resend.com/emails`, and
   `EMAIL_DELIVERY_MODE=http`.

5. Configure secrets without committing them:

   ```powershell
   npx wrangler secret put AUTH_SECRET
   npx wrangler secret put PASSWORD_PEPPER
   npx wrangler secret put EMAIL_PROVIDER_API_KEY
   npx wrangler secret put XAI_API_KEY
   npx wrangler secret put DEEPSEEK_API_KEY
   ```

   Only add the AI-provider secrets that the deployment uses.

6. Apply migrations and create the initial employee:

   ```powershell
   npm run db:migrate:remote
   npm run create-employee:remote
   ```

7. Build and deploy:

   ```powershell
   npm run deploy
   ```

8. Verify production cookies are `Secure`, the canonical URL is HTTPS, email
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
- complete requests, requests with every optional field blank, administrator
  message normalization, database null storage, and notification fallbacks;
- employee Admin Panel list access and client `403`;
- live employee/client role totals after approval, role change, and deletion;
- separate client/employee account lists, required two-stage client-removal
  confirmation, session revocation, disabled login, email status, and immutable
  removal audit recording;
- approval, audit recording, setup-token validation, password mismatch,
  automatic session creation, token reuse, and expiry;
- rejection, optional reason/audit display, and pending/rejected login denial;
- generic incorrect-password handling, unauthenticated API `401`, CSRF `403`,
  logout invalidation, and post-logout `401`;
- repeated-login throttling and absolute session expiry.
- password boundary validation (8 rejected, 9 and 63 accepted, 64 rejected),
  English-character enforcement, letters-only acceptance, password visibility,
  keyboard interaction, and value retention;
- interactive employee-command prompt order, validation, normalization, target
  selection, duplicate rejection, direct D1 creation, and non-zero failures;
- safe schema migration with existing rows and foreign keys;
- local workerd acceptance of the selected scrypt parameters;
- HTML escaping for applicant data, administrator messages, and rejection reasons in relevant email
  templates.

The existing editorial review/rewrite suites continue to run in the same test
command. Route tests mock only the authentication boundary so editorial
behavior remains isolated; the authentication suite exercises the real guards.

## Current limitations and next steps

- D1 fixed-window rate limiting is a practical application-layer control, but a
  high-risk public deployment should also add Cloudflare WAF rate-limit rules
  and optionally Turnstile to the public request/login forms.
- The Admin Panel is protected by application RBAC. Cloudflare Access can
  be added as defense in depth for employee routes without replacing RBAC.
- Resend's `onboarding@resend.dev` sender is suitable only for restricted
  testing. Verify a sending domain in Resend before allowing arbitrary
  applicants to use the production account-request workflow.
- This stage intentionally has no password-reset or account-settings UI.
- Session expiry is absolute; rotating/idle session policies can be added if
  required by organisational policy.
- The public published-content website remains a separate future system.
