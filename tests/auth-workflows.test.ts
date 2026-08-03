import {
  pbkdf2 as nodePbkdf2,
  scrypt as nodeScrypt,
} from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
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
import { POST as loginChallenge } from "@/app/api/auth/login/challenge/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as currentSession } from "@/app/api/auth/session/route";
import { POST as setupPassword } from "@/app/api/auth/setup-password/route";
import { POST as validateSetupToken } from "@/app/api/auth/setup-password/validate/route";
import {
  GET as getEmployeeRequest,
  PATCH as decideEmployeeRequest,
} from "@/app/api/employee/account-requests/[id]/route";
import { GET as getEmployeeAttachment } from "@/app/api/employee/account-requests/[id]/attachment/route";
import { GET as listEmployeeRequests } from "@/app/api/employee/account-requests/route";
import { POST as removeEmployeeClient } from "@/app/api/employee/accounts/[id]/remove/route";
import { GET as listEmployeeAccounts } from "@/app/api/employee/accounts/route";
import { POST as reviewDraft } from "@/app/api/review/route";
import { POST as extractDraftFile } from "@/app/api/uploads/extract/route";
import { hashPassword, nowInSeconds } from "@/lib/server/auth/crypto";
import { setDatabaseForTesting } from "@/lib/server/auth/database";
import { setAccountDocumentBucketForTesting } from "@/lib/server/uploads/storage";
import type { PasswordDerivation } from "@/lib/shared/auth-contracts";

const ORIGIN = "http://localhost";
const EMPLOYEE_EMAIL = "approver@example.test";
const EMPLOYEE_PASSWORD = "Strong-Employee-Password-42!";
const CLIENT_PASSWORD = "Strong-Client-Password-42!";

let miniflare: Miniflare;
let database: D1Database;
let accountDocuments: R2Bucket;
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

function deriveTestPasswordProof(
  password: string,
  derivation: PasswordDerivation,
) {
  const salt = Buffer.from(derivation.salt, "base64url");
  return new Promise<string>((resolve, reject) => {
    const callback = (error: Error | null, value: Buffer) => {
      if (error) reject(error);
      else resolve(value.toString("base64url"));
    };
    if (derivation.algorithm === "scrypt") {
      nodeScrypt(
        password,
        salt,
        derivation.keyLength,
        {
          N: derivation.cost,
          r: derivation.blockSize,
          p: derivation.parallelization,
          maxmem: 64 * 1024 * 1024,
        },
        callback,
      );
      return;
    }
    nodePbkdf2(
      password,
      salt,
      derivation.iterations,
      derivation.keyLength,
      "sha256",
      callback,
    );
  });
}

async function loginResponse(email: string, password: string) {
  const challengeResponse = await loginChallenge(
    jsonRequest("/api/auth/login/challenge", { email }),
  );
  if (!challengeResponse.ok) return challengeResponse;
  const challenge = (await challengeResponse.json()) as {
    derivation: PasswordDerivation;
  };
  const passwordProof = await deriveTestPasswordProof(
    password,
    challenge.derivation,
  );
  return login(
    jsonRequest("/api/auth/login", { email, password, passwordProof }),
  );
}

async function loginAs(email: string, password: string) {
  const response = await loginResponse(email, password);
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

function multipartAccountRequest(email: string, attachment: File) {
  const formData = new FormData();
  for (const [key, value] of Object.entries({
    fullName: "Applicant Person",
    email,
    phone: "+852 2345 6789",
    company: "Example News",
    department: "Editorial",
    jobTitle: "Editor",
    adminMessage: "Please review the attached supporting document.",
  })) {
    formData.set(key, value);
  }
  formData.set("attachment", attachment);
  return requestAccount(
    new Request(`${ORIGIN}/api/account-requests`, {
      method: "POST",
      headers: { Origin: ORIGIN },
      body: formData,
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

async function removeClient(
  clientId: string,
  authentication: { cookie: string; csrf: string },
  message: string,
) {
  return removeEmployeeClient(
    jsonRequest(
      `/api/employee/accounts/${clientId}/remove`,
      { message },
      authentication,
    ),
    routeContext(clientId),
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
    r2Buckets: ["ACCOUNT_DOCUMENTS"],
    cf: false,
  });
  database = (await miniflare.getD1Database("DB")) as D1Database;
  accountDocuments = (await miniflare.getR2Bucket(
    "ACCOUNT_DOCUMENTS",
  )) as unknown as R2Bucket;
  const migrationDirectory = new URL("../migrations/", import.meta.url);
  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migrationName of migrationNames) {
    const migration = await readFile(new URL(migrationName, migrationDirectory), "utf8");
    await executeSqlScript(migration);
  }
  setDatabaseForTesting(database);
  setAccountDocumentBucketForTesting(accountDocuments);
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
    DELETE FROM client_removal_audit_records;
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
  setAccountDocumentBucketForTesting(undefined);
  await miniflare.dispose();
});

describe("account authentication and approval workflows", () => {
  it("accepts complete and minimal requests, sanitizes messages, and rejects invalid fields", async () => {
    const successful = await submitRequest("new-client@example.test", {
      adminMessage: "Please review my newsroom access.",
    });
    expect(successful.status).toBe(201);
    expect(await successful.json()).toMatchObject({
      status: "pending",
      notificationStatus: "preview",
    });
    const completeRow = await database
      .prepare(
        `SELECT company, department, job_title, admin_message
         FROM account_requests WHERE email = ?`,
      )
      .bind("new-client@example.test")
      .first<{
        company: string | null;
        department: string | null;
        job_title: string | null;
        admin_message: string | null;
      }>();
    expect(completeRow).toEqual({
      company: "Example News",
      department: "Editorial",
      job_title: "Editor",
      admin_message: "Please review my newsroom access.",
    });

    const minimal = await submitRequest("minimal-client@example.test", {
      company: "",
      department: "   ",
      jobTitle: "",
      adminMessage: "",
    });
    expect(minimal.status).toBe(201);
    const minimalRow = await database
      .prepare(
        `SELECT company, department, job_title, admin_message
         FROM account_requests WHERE email = ?`,
      )
      .bind("minimal-client@example.test")
      .first<{
        company: string | null;
        department: string | null;
        job_title: string | null;
        admin_message: string | null;
      }>();
    expect(minimalRow).toEqual({
      company: null,
      department: null,
      job_title: null,
      admin_message: null,
    });

    const normalizedMessage = await submitRequest("message-client@example.test", {
      adminMessage: "  First line\r\nSecond <script>alert(1)</script>  ",
    });
    expect(normalizedMessage.status).toBe(201);
    expect(
      await database
        .prepare("SELECT admin_message FROM account_requests WHERE email = ?")
        .bind("message-client@example.test")
        .first<{ admin_message: string }>(),
    ).toEqual({
      admin_message: "First line\nSecond <script>alert(1)</script>",
    });

    const invalid = await submitRequest("invalid", {
      phone: "12",
      fullName: " ",
      adminMessage: "Invalid\u0000message",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        fieldErrors: {
          email: expect.any(Array),
          phone: expect.any(Array),
          fullName: expect.any(Array),
          adminMessage: expect.any(Array),
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
      summary: {
        employeeAccounts: 1,
        clientAccounts: 0,
      },
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

  it("stores account attachments privately and only lets employees view or download them", async () => {
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const submitted = await multipartAccountRequest(
      "attachment-client@example.test",
      new File([png], "../application.png", { type: "image/png" }),
    );
    expect(submitted.status).toBe(201);
    const requestId = ((await submitted.json()) as { requestId: string }).requestId;
    const row = await database
      .prepare(
        `SELECT original_name, content_type, size_bytes, storage_key
         FROM account_request_attachments
         WHERE account_request_id = ?`,
      )
      .bind(requestId)
      .first<{
        original_name: string;
        content_type: string;
        size_bytes: number;
        storage_key: string;
      }>();
    expect(row).toMatchObject({
      original_name: "_application.png",
      content_type: "image/png",
      size_bytes: png.length,
      storage_key: expect.stringMatching(/^account-requests\/[a-f0-9-]+$/u),
    });
    expect(row?.storage_key).not.toContain("application.png");

    const anonymous = await getEmployeeAttachment(
      getRequest(`/api/employee/account-requests/${requestId}/attachment`),
      routeContext(requestId),
    );
    expect(anonymous.status).toBe(401);

    await insertUser({
      id: "attachment-client-user",
      email: "attachment-reader@example.test",
      fullName: "Attachment Client",
      role: "client",
      passwordHash: clientHash,
    });
    const clientAuth = await loginAs(
      "attachment-reader@example.test",
      CLIENT_PASSWORD,
    );
    const forbidden = await getEmployeeAttachment(
      getRequest(
        `/api/employee/account-requests/${requestId}/attachment`,
        clientAuth.authentication.cookie,
      ),
      routeContext(requestId),
    );
    expect(forbidden.status).toBe(403);

    const employeeAuth = await employeeAuthentication();
    const viewed = await getEmployeeAttachment(
      getRequest(
        `/api/employee/account-requests/${requestId}/attachment?mode=view`,
        employeeAuth.cookie,
      ),
      routeContext(requestId),
    );
    expect(viewed.status).toBe(200);
    expect(viewed.headers.get("content-type")).toBe("image/png");
    expect(viewed.headers.get("content-disposition")).toContain("inline");
    expect(viewed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await viewed.arrayBuffer())).toEqual(png);

    const details = await getEmployeeRequest(
      getRequest(
        `/api/employee/account-requests/${requestId}`,
        employeeAuth.cookie,
      ),
      routeContext(requestId),
    );
    const detailsBody = await details.json();
    expect(detailsBody).toMatchObject({
      request: {
        id: requestId,
        attachment: {
          fileName: "_application.png",
          mimeType: "image/png",
          size: png.length,
        },
      },
    });
    expect(JSON.stringify(detailsBody)).not.toContain("storage_key");
    expect(JSON.stringify(detailsBody)).not.toContain("storageKey");
  });

  it("protects Draft extraction with session and CSRF checks before processing files", async () => {
    function uploadRequest(authentication?: { cookie: string; csrf?: string }) {
      const formData = new FormData();
      formData.set(
        "file",
        new File([Uint8Array.from([1, 2, 3])], "broken.pdf", {
          type: "application/pdf",
        }),
      );
      return new Request(`${ORIGIN}/api/uploads/extract`, {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          ...(authentication?.cookie ? { Cookie: authentication.cookie } : {}),
          ...(authentication?.csrf
            ? { "X-CSRF-Token": authentication.csrf }
            : {}),
        },
        body: formData,
      });
    }

    expect((await extractDraftFile(uploadRequest())).status).toBe(401);

    await insertUser({
      id: "draft-upload-client",
      email: "draft-upload@example.test",
      fullName: "Draft Upload Client",
      role: "client",
      passwordHash: clientHash,
    });
    const client = await loginAs("draft-upload@example.test", CLIENT_PASSWORD);
    expect(
      (
        await extractDraftFile(
          uploadRequest({ cookie: client.authentication.cookie }),
        )
      ).status,
    ).toBe(403);

    const corrupted = await extractDraftFile(
      uploadRequest(client.authentication),
    );
    expect(corrupted.status).toBe(400);
    expect(await corrupted.json()).toMatchObject({
      error: {
        code: "FILE_TYPE_MISMATCH",
        message: expect.stringContaining("do not match"),
      },
    });
  });

  it("calculates role totals from user roles and refreshes after approval, role change, and deletion", async () => {
    const submitted = await submitRequest("counted-client@example.test");
    const requestId = ((await submitted.json()) as { requestId: string }).requestId;
    const employeeAuth = await employeeAuthentication();

    const beforeApproval = await listEmployeeRequests(
      getRequest("/api/employee/account-requests", employeeAuth.cookie),
    );
    expect(await beforeApproval.json()).toMatchObject({
      summary: { employeeAccounts: 1, clientAccounts: 0 },
    });

    expect((await approve(requestId, employeeAuth)).status).toBe(200);
    const afterApproval = await listEmployeeRequests(
      getRequest("/api/employee/account-requests", employeeAuth.cookie),
    );
    expect(await afterApproval.json()).toMatchObject({
      summary: { employeeAccounts: 1, clientAccounts: 1 },
    });

    await database
      .prepare("UPDATE users SET role = 'employee' WHERE email = ?")
      .bind("counted-client@example.test")
      .run();
    const afterRoleChange = await listEmployeeRequests(
      getRequest("/api/employee/account-requests", employeeAuth.cookie),
    );
    expect(await afterRoleChange.json()).toMatchObject({
      summary: { employeeAccounts: 2, clientAccounts: 0 },
    });

    await database
      .prepare("DELETE FROM users WHERE email = ?")
      .bind("counted-client@example.test")
      .run();
    const afterDeletion = await listEmployeeRequests(
      getRequest("/api/employee/account-requests", employeeAuth.cookie),
    );
    expect(await afterDeletion.json()).toMatchObject({
      summary: { employeeAccounts: 1, clientAccounts: 0 },
    });
  });

  it("separates account lists and safely removes a client with sessions and an audit record", async () => {
    await insertUser({
      id: "client-remove",
      email: "remove-client@example.test",
      fullName: "Removable Client",
      role: "client",
      passwordHash: clientHash,
    });
    const clientLogin = await loginAs(
      "remove-client@example.test",
      CLIENT_PASSWORD,
    );
    expect(clientLogin.response.status).toBe(200);
    const employeeAuth = await employeeAuthentication();

    const clients = await listEmployeeAccounts(
      getRequest(
        "/api/employee/accounts?role=client",
        employeeAuth.cookie,
      ),
    );
    expect(clients.status).toBe(200);
    expect(await clients.json()).toMatchObject({
      accounts: [
        {
          id: "client-remove",
          fullName: "Removable Client",
          email: "remove-client@example.test",
          role: "client",
        },
      ],
      summary: { employeeAccounts: 1, clientAccounts: 1 },
    });

    const employees = await listEmployeeAccounts(
      getRequest(
        "/api/employee/accounts?role=employee",
        employeeAuth.cookie,
      ),
    );
    expect(employees.status).toBe(200);
    expect(await employees.json()).toMatchObject({
      accounts: [
        {
          id: "employee-1",
          email: EMPLOYEE_EMAIL,
          role: "employee",
        },
      ],
    });

    const forbiddenList = await listEmployeeAccounts(
      getRequest(
        "/api/employee/accounts?role=client",
        clientLogin.authentication.cookie,
      ),
    );
    expect(forbiddenList.status).toBe(403);

    const forbiddenRemoval = await removeEmployeeClient(
      jsonRequest(
        "/api/employee/accounts/client-remove/remove",
        { message: "A client cannot remove this account." },
        clientLogin.authentication,
      ),
      routeContext("client-remove"),
    );
    expect(forbiddenRemoval.status).toBe(403);

    const emptyMessage = await removeClient(
      "client-remove",
      employeeAuth,
      "   ",
    );
    expect(emptyMessage.status).toBe(400);
    expect(await emptyMessage.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        fieldErrors: { message: expect.any(Array) },
      },
    });
    expect(
      await database
        .prepare(
          "SELECT status FROM users WHERE id = 'client-remove'",
        )
        .first<{ status: string }>(),
    ).toEqual({ status: "active" });

    const removalMessage =
      "Your project access is no longer required.\r\nContact the newsroom administrator with questions.";
    const removed = await removeClient(
      "client-remove",
      employeeAuth,
      removalMessage,
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      removedAccount: {
        id: "client-remove",
        email: "remove-client@example.test",
      },
      audit: {
        removedClientAccountId: "client-remove",
        clientEmail: "remove-client@example.test",
        administratorAccountId: "employee-1",
        removalMessage:
          "Your project access is no longer required.\nContact the newsroom administrator with questions.",
        createdAt: expect.any(Number),
      },
      emailDelivery: { status: "preview" },
    });

    expect(
      await database
        .prepare(
          `SELECT status, password_hash, password_set_at
           FROM users WHERE id = ?`,
        )
        .bind("client-remove")
        .first<{
          status: string;
          password_hash: string | null;
          password_set_at: number | null;
        }>(),
    ).toEqual({
      status: "disabled",
      password_hash: null,
      password_set_at: null,
    });
    const clientSessions = await database
      .prepare(
        "SELECT revoked_at FROM sessions WHERE user_id = ?",
      )
      .bind("client-remove")
      .all<{ revoked_at: number | null }>();
    expect(clientSessions.results.length).toBeGreaterThan(0);
    expect(clientSessions.results.every((session) => session.revoked_at)).toBe(
      true,
    );
    expect(
      await database
        .prepare(
          `SELECT
             removed_client_user_id,
             client_email,
             actor_user_id,
             removal_message,
             email_status,
             created_at
           FROM client_removal_audit_records
           WHERE removed_client_user_id = ?`,
        )
        .bind("client-remove")
        .first(),
    ).toMatchObject({
      removed_client_user_id: "client-remove",
      client_email: "remove-client@example.test",
      actor_user_id: "employee-1",
      removal_message:
        "Your project access is no longer required.\nContact the newsroom administrator with questions.",
      email_status: "preview",
      created_at: expect.any(Number),
    });

    const oldSession = await currentSession(
      getRequest(
        "/api/auth/session",
        clientLogin.authentication.cookie,
      ),
    );
    expect(oldSession.status).toBe(401);
    const loginAfterRemoval = await loginResponse(
      "remove-client@example.test",
      CLIENT_PASSWORD,
    );
    expect(loginAfterRemoval.status).toBe(401);

    const refreshed = await listEmployeeAccounts(
      getRequest(
        "/api/employee/accounts?role=client",
        employeeAuth.cookie,
      ),
    );
    expect(await refreshed.json()).toMatchObject({
      accounts: [],
      summary: { employeeAccounts: 1, clientAccounts: 0 },
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
    const tokenCheckBody = (await tokenCheck.json()) as {
      email: string;
      derivation: PasswordDerivation;
    };
    expect(tokenCheckBody).toMatchObject({
      email: "approved-client@example.test",
    });
    const setupProof = await deriveTestPasswordProof(
      CLIENT_PASSWORD,
      tokenCheckBody.derivation,
    );

    const mismatch = await setupPassword(
      jsonRequest("/api/auth/setup-password", {
        token,
        newPassword: CLIENT_PASSWORD,
        confirmPassword: "Does-not-match-42!",
        passwordSalt: tokenCheckBody.derivation.salt,
        passwordProof: setupProof,
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
        passwordSalt: tokenCheckBody.derivation.salt,
        passwordProof: setupProof,
      }),
    );
    expect(completed.status).toBe(200);
    expect(responseCookies(completed).cookie).toContain("pressready_session=");

    const reused = await setupPassword(
      jsonRequest("/api/auth/setup-password", {
        token,
        newPassword: CLIENT_PASSWORD,
        confirmPassword: CLIENT_PASSWORD,
        passwordSalt: tokenCheckBody.derivation.salt,
        passwordProof: setupProof,
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
    const pendingLogin = await loginResponse(
      "pending-login@example.test",
      CLIENT_PASSWORD,
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

    const rejectedLogin = await loginResponse(
      "rejected-client@example.test",
      CLIENT_PASSWORD,
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

    const incorrect = await loginResponse(
      "login-client@example.test",
      "Incorrect-Password-42!",
    );
    expect(incorrect.status).toBe(401);
    expect(await incorrect.json()).toMatchObject({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "The email address or password is incorrect.",
      },
    });

    const unknown = await loginResponse(
      "unknown-client@example.test",
      CLIENT_PASSWORD,
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({
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

    const challengeResponse = await loginChallenge(
      jsonRequest("/api/auth/login/challenge", {
        email: "rate-client@example.test",
      }),
    );
    expect(challengeResponse.status).toBe(200);
    const challenge = (await challengeResponse.json()) as {
      derivation: PasswordDerivation;
    };
    const incorrectProof = await deriveTestPasswordProof(
      "Incorrect-Password-42!",
      challenge.derivation,
    );
    const failedLogin = () =>
      login(
        jsonRequest("/api/auth/login", {
          email: "rate-client@example.test",
          password: "Incorrect-Password-42!",
          passwordProof: incorrectProof,
        }),
      );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await failedLogin();
      expect(response.status).toBe(401);
    }
    const limited = await failedLogin();
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
