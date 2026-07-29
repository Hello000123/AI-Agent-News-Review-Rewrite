import { readFile } from "node:fs/promises";

import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { POST as requestAccount } from "@/app/api/account-requests/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as currentSession } from "@/app/api/auth/session/route";
import { POST as setupPassword } from "@/app/api/auth/setup-password/route";
import { POST as validateSetupToken } from "@/app/api/auth/setup-password/validate/route";
import {
  GET as getEmployeeRequest,
  PATCH as decideEmployeeRequest,
} from "@/app/api/employee/account-requests/[id]/route";
import { GET as listEmployeeRequests } from "@/app/api/employee/account-requests/route";
import { POST as reviewDraft } from "@/app/api/review/route";
import { hashPassword, nowInSeconds } from "@/lib/server/auth/crypto";
import { setDatabaseForTesting } from "@/lib/server/auth/database";

const ORIGIN = "http://localhost";
const EMPLOYEE_EMAIL = "approver@example.test";
const EMPLOYEE_PASSWORD = "Strong-Employee-Password-42!";
const CLIENT_PASSWORD = "Strong-Client-Password-42!";

let miniflare: Miniflare;
let database: D1Database;
let employeeHash: string;
let clientHash: string;

function jsonRequest(
  pathname: string,
  body: unknown,
  authentication?: { cookie: string; csrf: string },
) {
  return new Request(`${ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...(authentication
        ? {
            Cookie: authentication.cookie,
            "X-CSRF-Token": authentication.csrf,
          }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

function getRequest(pathname: string, cookie?: string) {
  return new Request(`${ORIGIN}${pathname}`, {
    method: "GET",
    headers: cookie ? { Cookie: cookie } : {},
  });
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function responseCookies(response: Response) {
  const values =
    "getSetCookie" in response.headers &&
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  const pairs = values
    .flatMap((value) => value.split(/,(?=\s*pressready_)/gu))
    .map((value) => value.trim().split(";")[0])
    .filter(Boolean);
  const cookie = pairs.join("; ");
  const csrfPair = pairs.find((value) => value.startsWith("pressready_csrf="));
  return {
    cookie,
    csrf: csrfPair?.slice("pressready_csrf=".length) ?? "",
  };
}

async function insertUser(values: {
  id: string;
  email: string;
  fullName: string;
  role: "client" | "employee";
  status?: "setup_pending" | "active" | "disabled";
  passwordHash?: string | null;
}) {
  const now = nowInSeconds();
  await database
    .prepare(
      `INSERT INTO users (
        id, email, full_name, password_hash, role, status,
        created_at, updated_at, password_set_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      values.id,
      values.email,
      values.fullName,
      values.passwordHash ?? null,
      values.role,
      values.status ?? "active",
      now,
      now,
      values.passwordHash ? now : null,
    )
    .run();
}

async function loginAs(email: string, password: string) {
  const response = await login(
    jsonRequest("/api/auth/login", { email, password }),
  );
  return { response, authentication: responseCookies(response) };
}

async function submitRequest(email: string, overrides: Record<string, unknown> = {}) {
  return requestAccount(
    jsonRequest("/api/account-requests", {
      fullName: "Applicant Person",
      email,
      phone: "+852 2345 6789",
      company: "Example News",
      department: "Editorial",
      jobTitle: "Editor",
      ...overrides,
    }),
  );
}

async function employeeAuthentication() {
  const result = await loginAs(EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
  expect(result.response.status).toBe(200);
  return result.authentication;
}

async function approve(
  requestId: string,
  authentication: { cookie: string; csrf: string },
) {
  return decideEmployeeRequest(
    new Request(`${ORIGIN}/api/employee/account-requests/${requestId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: authentication.cookie,
        "X-CSRF-Token": authentication.csrf,
      },
      body: JSON.stringify({ action: "approve" }),
    }),
    routeContext(requestId),
  );
}

function tokenFromPreviewUrl(url: string) {
  const fragment = new URL(url).hash.slice(1);
  return new URLSearchParams(fragment).get("token") ?? "";
}

async function executeSqlScript(sql: string) {
  for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
}

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: "11111111-1111-1111-1111-111111111111" },
    cf: false,
  });
  database = (await miniflare.getD1Database("DB")) as D1Database;
  const migration = await readFile(
    new URL("../migrations/0001_authentication.sql", import.meta.url),
    "utf8",
  );
  await executeSqlScript(migration);
  setDatabaseForTesting(database);
  [employeeHash, clientHash] = await Promise.all([
    hashPassword(EMPLOYEE_PASSWORD),
    hashPassword(CLIENT_PASSWORD),
  ]);
});

beforeEach(async () => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("PUBLIC_APP_URL", ORIGIN);
  vi.stubEnv("AUTH_SECRET", "test-auth-secret-that-is-longer-than-thirty-two-characters");
  vi.stubEnv("EMAIL_DELIVERY_MODE", "preview");
  vi.stubEnv("ACCOUNT_APPROVAL_NOTIFICATION_EMAIL", "notifications@example.test");
  await executeSqlScript(`
    DELETE FROM email_delivery_records;
    DELETE FROM approval_audit_records;
    DELETE FROM sessions;
    DELETE FROM password_setup_tokens;
    UPDATE account_requests SET decided_by = NULL;
    DELETE FROM users;
    DELETE FROM account_requests;
    DELETE FROM login_rate_limits;
  `);
  await insertUser({
    id: "employee-1",
    email: EMPLOYEE_EMAIL,
    fullName: "Approval Employee",
    role: "employee",
    passwordHash: employeeHash,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  setDatabaseForTesting(undefined);
  await miniflare.dispose();
});

describe("account authentication and approval workflows", () => {
  it("accepts a valid request, rejects invalid fields, and prevents duplicate pending email", async () => {
    const successful = await submitRequest("new-client@example.test");
    expect(successful.status).toBe(201);
    expect(await successful.json()).toMatchObject({
      status: "pending",
      notificationStatus: "preview",
    });

    const invalid = await submitRequest("invalid", {
      phone: "12",
      fullName: " ",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        fieldErrors: {
          email: expect.any(Array),
          phone: expect.any(Array),
          fullName: expect.any(Array),
        },
      },
    });

    const duplicate = await submitRequest("new-client@example.test");
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      error: { code: "DUPLICATE_ACCOUNT_REQUEST" },
    });

    await insertUser({
      id: "existing-active",
      email: "existing-active@example.test",
      fullName: "Existing Active Client",
      role: "client",
      passwordHash: clientHash,
    });
    const duplicateActive = await submitRequest("existing-active@example.test");
    expect(duplicateActive.status).toBe(409);
    expect(await duplicateActive.json()).toMatchObject({
      error: { code: "DUPLICATE_ACCOUNT_REQUEST" },
    });
  });

  it("lets an employee view pending requests while denying a client employee access", async () => {
    const submitted = await submitRequest("pending-view@example.test");
    const requestId = ((await submitted.json()) as { requestId: string }).requestId;
    const employeeAuth = await employeeAuthentication();

    const list = await listEmployeeRequests(
      getRequest("/api/employee/account-requests?status=pending", employeeAuth.cookie),
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      requests: [expect.objectContaining({ id: requestId, status: "pending" })],
    });

    await insertUser({
      id: "client-active",
      email: "active-client@example.test",
      fullName: "Active Client",
      role: "client",
      passwordHash: clientHash,
    });
    const clientAuth = await loginAs("active-client@example.test", CLIENT_PASSWORD);
    const forbidden = await listEmployeeRequests(
      getRequest("/api/employee/account-requests", clientAuth.authentication.cookie),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });

  it("approves a request, creates one setup link, validates passwords, and blocks expired or reused links", async () => {
    const submitted = await submitRequest("approved-client@example.test");
    const requestId = ((await submitted.json()) as { requestId: string }).requestId;
    const employeeAuth = await employeeAuthentication();
    const approved = await approve(requestId, employeeAuth);
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as {
      request: { status: string; decidedBy: { email: string } };
      emailDelivery: { status: string; developmentSetupUrl: string };
    };
    expect(approvedBody.request).toMatchObject({
      status: "approved",
      decidedBy: { email: EMPLOYEE_EMAIL },
    });
    expect(approvedBody.emailDelivery.status).toBe("preview");
    expect(approvedBody.emailDelivery.developmentSetupUrl).toContain("#token=");
    const approvalAudit = await database
      .prepare(
        "SELECT action, actor_user_id FROM approval_audit_records WHERE account_request_id = ?",
      )
      .bind(requestId)
      .first<{ action: string; actor_user_id: string }>();
    expect(approvalAudit).toEqual({
      action: "approved",
      actor_user_id: "employee-1",
    });
    const token = tokenFromPreviewUrl(approvedBody.emailDelivery.developmentSetupUrl);

    const tokenCheck = await validateSetupToken(
      jsonRequest("/api/auth/setup-password/validate", { token }),
    );
    expect(tokenCheck.status).toBe(200);
    expect(await tokenCheck.json()).toMatchObject({
      email: "approved-client@example.test",
    });

    const mismatch = await setupPassword(
      jsonRequest("/api/auth/setup-password", {
        token,
        newPassword: CLIENT_PASSWORD,
        confirmPassword: "Does-not-match-42!",
      }),
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        fieldErrors: { confirmPassword: expect.any(Array) },
      },
    });

    const completed = await setupPassword(
      jsonRequest("/api/auth/setup-password", {
        token,
        newPassword: CLIENT_PASSWORD,
        confirmPassword: CLIENT_PASSWORD,
      }),
    );
    expect(completed.status).toBe(200);
    expect(responseCookies(completed).cookie).toContain("pressready_session=");

    const reused = await setupPassword(
      jsonRequest("/api/auth/setup-password", {
        token,
        newPassword: CLIENT_PASSWORD,
        confirmPassword: CLIENT_PASSWORD,
      }),
    );
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({
      error: { code: "INVALID_SETUP_TOKEN" },
    });

    const another = await submitRequest("expired-client@example.test");
    const anotherId = ((await another.json()) as { requestId: string }).requestId;
    const anotherApproval = await approve(anotherId, employeeAuth);
    const anotherBody = (await anotherApproval.json()) as {
      emailDelivery: { developmentSetupUrl: string };
    };
    const expiredToken = tokenFromPreviewUrl(anotherBody.emailDelivery.developmentSetupUrl);
    await database
      .prepare("UPDATE password_setup_tokens SET expires_at = ? WHERE token_hash IS NOT NULL AND used_at IS NULL")
      .bind(nowInSeconds() - 1)
      .run();
    const expired = await validateSetupToken(
      jsonRequest("/api/auth/setup-password/validate", { token: expiredToken }),
    );
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({
      error: { code: "INVALID_SETUP_TOKEN" },
    });
  });

  it("records rejection details and rejected or pending applicants cannot log in", async () => {
    const pending = await submitRequest("pending-login@example.test");
    expect(pending.status).toBe(201);
    const pendingLogin = await login(
      jsonRequest("/api/auth/login", {
        email: "pending-login@example.test",
        password: CLIENT_PASSWORD,
      }),
    );
    expect(pendingLogin.status).toBe(401);

    const rejected = await submitRequest("rejected-client@example.test");
    const requestId = ((await rejected.json()) as { requestId: string }).requestId;
    const employeeAuth = await employeeAuthentication();
    const rejection = await decideEmployeeRequest(
      new Request(`${ORIGIN}/api/employee/account-requests/${requestId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: employeeAuth.cookie,
          "X-CSRF-Token": employeeAuth.csrf,
        },
        body: JSON.stringify({
          action: "reject",
          rejectionReason: "The organisation could not be verified.",
        }),
      }),
      routeContext(requestId),
    );
    expect(rejection.status).toBe(200);
    expect(await rejection.json()).toMatchObject({
      request: {
        status: "rejected",
        rejectionReason: "The organisation could not be verified.",
        decidedBy: { email: EMPLOYEE_EMAIL },
      },
      emailDelivery: { status: "preview" },
    });

    const detail = await getEmployeeRequest(
      getRequest(`/api/employee/account-requests/${requestId}`, employeeAuth.cookie),
      routeContext(requestId),
    );
    expect(await detail.json()).toMatchObject({
      request: { status: "rejected", decidedAt: expect.any(Number) },
    });
    const rejectionAudit = await database
      .prepare(
        "SELECT action, actor_user_id, reason FROM approval_audit_records WHERE account_request_id = ?",
      )
      .bind(requestId)
      .first<{ action: string; actor_user_id: string; reason: string }>();
    expect(rejectionAudit).toEqual({
      action: "rejected",
      actor_user_id: "employee-1",
      reason: "The organisation could not be verified.",
    });

    const rejectedLogin = await login(
      jsonRequest("/api/auth/login", {
        email: "rejected-client@example.test",
        password: CLIENT_PASSWORD,
      }),
    );
    expect(rejectedLogin.status).toBe(401);
    expect(await rejectedLogin.json()).toMatchObject({
      error: { code: "INVALID_CREDENTIALS" },
    });
  });

  it("uses generic login failures, protects APIs, and invalidates the session at logout", async () => {
    await insertUser({
      id: "client-login",
      email: "login-client@example.test",
      fullName: "Login Client",
      role: "client",
      passwordHash: clientHash,
    });

    const incorrect = await login(
      jsonRequest("/api/auth/login", {
        email: "login-client@example.test",
        password: "Incorrect-Password-42!",
      }),
    );
    expect(incorrect.status).toBe(401);
    expect(await incorrect.json()).toMatchObject({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "The email address or password is incorrect.",
      },
    });

    const successful = await loginAs("login-client@example.test", CLIENT_PASSWORD);
    expect(successful.response.status).toBe(200);
    const session = await currentSession(
      getRequest("/api/auth/session", successful.authentication.cookie),
    );
    expect(session.status).toBe(200);

    const unauthenticatedApi = await reviewDraft(
      jsonRequest("/api/review", { draft: "A protected draft." }),
    );
    expect(unauthenticatedApi.status).toBe(401);

    const missingCsrf = await reviewDraft(
      new Request(`${ORIGIN}/api/review`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: successful.authentication.cookie,
        },
        body: JSON.stringify({ draft: "A protected draft." }),
      }),
    );
    expect(missingCsrf.status).toBe(403);
    expect(await missingCsrf.json()).toMatchObject({
      error: { code: "CSRF_REJECTED" },
    });

    const loggedOut = await logout(
      jsonRequest("/api/auth/logout", {}, successful.authentication),
    );
    expect(loggedOut.status).toBe(200);
    expect(loggedOut.headers.get("clear-site-data")).toBe('"cache", "storage"');

    const afterLogout = await currentSession(
      getRequest("/api/auth/session", successful.authentication.cookie),
    );
    expect(afterLogout.status).toBe(401);
  });

  it("rate limits repeated failures and rejects expired sessions", async () => {
    await insertUser({
      id: "client-rate",
      email: "rate-client@example.test",
      fullName: "Rate Client",
      role: "client",
      passwordHash: clientHash,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await login(
        jsonRequest("/api/auth/login", {
          email: "rate-client@example.test",
          password: "Incorrect-Password-42!",
        }),
      );
      expect(response.status).toBe(401);
    }
    const limited = await login(
      jsonRequest("/api/auth/login", {
        email: "rate-client@example.test",
        password: "Incorrect-Password-42!",
      }),
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      error: { code: "LOGIN_RATE_LIMITED" },
    });

    const signedIn = await loginAs(EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
    const ipFailureBucket = await database
      .prepare("SELECT attempt_count FROM login_rate_limits WHERE scope = 'ip' LIMIT 1")
      .first<{ attempt_count: number }>();
    expect(ipFailureBucket?.attempt_count).toBe(5);
    await database.prepare("UPDATE sessions SET expires_at = 0").run();
    const expired = await currentSession(
      getRequest("/api/auth/session", signedIn.authentication.cookie),
    );
    expect(expired.status).toBe(401);
  });
});
