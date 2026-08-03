import type { D1Database, D1Result } from "@cloudflare/workers-types";

import {
  getPasswordPepper,
  getPasswordSetupTtlSeconds,
} from "@/lib/server/auth/config";
import {
  createId,
  nowInSeconds,
  randomToken,
  sealPasswordProof,
  sha256,
} from "@/lib/server/auth/crypto";
import {
  approvedAccountEmail,
  deliverEmail,
  newAccountRequestEmail,
  rejectedAccountEmail,
  removedClientAccountEmail,
  type EmailDeliveryResult,
} from "@/lib/server/auth/email";
import {
  createPendingAccountRequest,
  getAccountRequestById,
  getActiveClientAccount,
  getSetupTokenByHash,
  recordEmailDelivery,
  updateClientRemovalEmailStatus,
} from "@/lib/server/auth/repository";
import { validateUploadedFile } from "@/lib/server/uploads/file-processing";
import { getAccountDocumentBucket } from "@/lib/server/uploads/storage";
import { buildSessionMaterial, type SessionMaterial } from "@/lib/server/auth/sessions";
import { AppError } from "@/lib/server/errors";
import {
  PASSWORD_PROOF_BYTES,
  PASSWORD_SALT_BYTES,
  SCRYPT_BLOCK_SIZE,
  SCRYPT_COST,
  SCRYPT_PARALLELIZATION,
} from "@/lib/shared/auth-contracts";
import type {
  AccountRequestInput,
  AccountRequestView,
  AuthenticatedUser,
  ClientRemovalAuditView,
  PasswordDerivation,
} from "@/lib/shared/auth-contracts";

function changed(result: D1Result) {
  return Number(result.meta.changes ?? 0);
}

function scryptPasswordDerivation(salt: string): PasswordDerivation {
  return {
    algorithm: "scrypt",
    salt,
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    keyLength: PASSWORD_PROOF_BYTES,
  };
}

async function recordDelivery(
  database: D1Database,
  request: AccountRequestView,
  messageType: "new_request" | "approved_setup" | "rejected",
  recipient: string,
  delivery: EmailDeliveryResult,
) {
  await recordEmailDelivery(database, {
    accountRequestId: request.id,
    messageType,
    recipient,
    status: delivery.status,
    providerMessageId: delivery.providerMessageId,
    errorCode: delivery.errorCode,
  });
}

export async function submitAccountRequest(
  database: D1Database,
  input: AccountRequestInput,
  publicAppUrl: string,
  attachmentFile?: File,
) {
  let attachment:
    | {
        id: string;
        storageKey: string;
        fileName: string;
        mimeType: string;
        size: number;
        createdAt: number;
      }
    | undefined;
  let bucket: ReturnType<typeof getAccountDocumentBucket> | undefined;

  if (attachmentFile) {
    const validated = await validateUploadedFile(attachmentFile);
    bucket = getAccountDocumentBucket();
    attachment = {
      id: createId(),
      storageKey: `account-requests/${createId()}`,
      fileName: validated.safeName,
      mimeType: validated.mimeType,
      size: validated.size,
      createdAt: nowInSeconds(),
    };
    try {
      await bucket.put(attachment.storageKey, validated.bytes, {
        httpMetadata: { contentType: attachment.mimeType },
      });
    } catch (error) {
      throw new AppError(
        "DOCUMENT_STORAGE_UNAVAILABLE",
        "The supporting document could not be stored securely. Try again later.",
        503,
        { cause: error },
      );
    }
  }

  let request: AccountRequestView;
  try {
    request = await createPendingAccountRequest(database, input, attachment);
  } catch (error) {
    if (attachment && bucket) {
      await bucket.delete(attachment.storageKey).catch(() => undefined);
    }
    throw error;
  }
  let delivery: EmailDeliveryResult;
  try {
    delivery = await deliverEmail(newAccountRequestEmail(request, publicAppUrl));
  } catch {
    delivery = { status: "failed", errorCode: "TEMPLATE_CONFIGURATION" };
  }
  await recordDelivery(
    database,
    request,
    "new_request",
    process.env.ACCOUNT_APPROVAL_NOTIFICATION_EMAIL?.trim().toLowerCase() ||
      "employee@example.test",
    delivery,
  );
  return { request, delivery };
}

function assertEmployee(employee: AuthenticatedUser) {
  if (employee.role !== "employee") {
    throw new AppError(
      "FORBIDDEN",
      "You do not have permission to perform this action.",
      403,
    );
  }
}

export async function approveAccountRequest(
  database: D1Database,
  requestId: string,
  employee: AuthenticatedUser,
  publicAppUrl: string,
) {
  assertEmployee(employee);
  const existing = await getAccountRequestById(database, requestId);
  if (!existing) {
    throw new AppError("ACCOUNT_REQUEST_NOT_FOUND", "Account request not found.", 404);
  }
  if (existing.status !== "pending") {
    throw new AppError(
      "ACCOUNT_REQUEST_ALREADY_DECIDED",
      "This account request has already been decided.",
      409,
    );
  }

  const now = nowInSeconds();
  const decisionId = createId();
  const userId = createId();
  const tokenId = createId();
  const auditId = createId();
  const rawToken = randomToken();
  const tokenHash = await sha256(rawToken);
  const expiresAt = now + getPasswordSetupTtlSeconds();
  const setupUrl = `${publicAppUrl}/setup-password#token=${encodeURIComponent(rawToken)}`;

  try {
    const results = await database.batch([
      database
        .prepare(
          `UPDATE account_requests
           SET status = 'approved',
               decided_by = ?,
               decided_at = ?,
               rejection_reason = NULL,
               decision_id = ?,
               updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(employee.id, now, decisionId, now, requestId),
      database
        .prepare(
          `INSERT INTO users (
            id, email, full_name, phone, company, department, job_title,
            password_hash, role, status, account_request_id, created_at, updated_at
           )
           SELECT
            ?, email, full_name, phone, company, department, job_title,
            NULL, 'client', 'setup_pending', id, ?, ?
           FROM account_requests
           WHERE id = ? AND decision_id = ?`,
        )
        .bind(userId, now, now, requestId, decisionId),
      database
        .prepare(
          `INSERT INTO password_setup_tokens (
            id, user_id, token_hash, expires_at, created_at
           ) VALUES (
            ?,
            (
              SELECT user.id
              FROM users AS user
              INNER JOIN account_requests AS request
                ON request.id = user.account_request_id
              WHERE request.id = ?
                AND request.decision_id = ?
                AND user.status = 'setup_pending'
              LIMIT 1
            ),
            ?,
            ?,
            ?
           )`,
        )
        .bind(tokenId, requestId, decisionId, tokenHash, expiresAt, now),
      database
        .prepare(
          `INSERT INTO approval_audit_records (
            id, account_request_id, actor_user_id, action, created_at
           ) VALUES (?, ?, ?, 'approved', ?)`,
        )
        .bind(auditId, requestId, employee.id, now),
    ]);
    if (changed(results[0]) !== 1 || changed(results[2]) !== 1) {
      throw new Error("Approval state changed concurrently.");
    }
  } catch (error) {
    const latest = await getAccountRequestById(database, requestId);
    if (latest?.status !== "pending") {
      throw new AppError(
        "ACCOUNT_REQUEST_ALREADY_DECIDED",
        "This account request has already been decided.",
        409,
      );
    }
    throw new AppError(
      "ACCOUNT_APPROVAL_FAILED",
      "The account could not be approved. Please try again.",
      500,
      { cause: error },
    );
  }

  const request = await getAccountRequestById(database, requestId);
  if (!request) {
    throw new AppError(
      "ACCOUNT_APPROVAL_FAILED",
      "The account could not be approved. Please try again.",
      500,
    );
  }
  const delivery = await deliverEmail(approvedAccountEmail(request, setupUrl, expiresAt));
  await recordDelivery(database, request, "approved_setup", request.email, delivery);
  return { request, delivery };
}

export async function rejectAccountRequest(
  database: D1Database,
  requestId: string,
  employee: AuthenticatedUser,
  rejectionReason?: string,
) {
  assertEmployee(employee);
  const existing = await getAccountRequestById(database, requestId);
  if (!existing) {
    throw new AppError("ACCOUNT_REQUEST_NOT_FOUND", "Account request not found.", 404);
  }
  if (existing.status !== "pending") {
    throw new AppError(
      "ACCOUNT_REQUEST_ALREADY_DECIDED",
      "This account request has already been decided.",
      409,
    );
  }

  const now = nowInSeconds();
  const decisionId = createId();
  const results = await database.batch([
    database
      .prepare(
        `UPDATE account_requests
         SET status = 'rejected',
             decided_by = ?,
             decided_at = ?,
             rejection_reason = ?,
             decision_id = ?,
             updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(employee.id, now, rejectionReason || null, decisionId, now, requestId),
    database
      .prepare(
        `INSERT INTO approval_audit_records (
          id, account_request_id, actor_user_id, action, reason, created_at
         )
         SELECT ?, id, ?, 'rejected', ?, ?
         FROM account_requests
         WHERE id = ? AND decision_id = ?`,
      )
      .bind(
        createId(),
        employee.id,
        rejectionReason || null,
        now,
        requestId,
        decisionId,
      ),
  ]);

  if (changed(results[0]) !== 1) {
    throw new AppError(
      "ACCOUNT_REQUEST_ALREADY_DECIDED",
      "This account request has already been decided.",
      409,
    );
  }

  const request = await getAccountRequestById(database, requestId);
  if (!request) {
    throw new AppError(
      "ACCOUNT_REJECTION_FAILED",
      "The account request could not be rejected. Please try again.",
      500,
    );
  }
  const delivery = await deliverEmail(rejectedAccountEmail(request, rejectionReason));
  await recordDelivery(database, request, "rejected", request.email, delivery);
  return { request, delivery };
}

export async function resendPasswordSetupEmail(
  database: D1Database,
  requestId: string,
  employee: AuthenticatedUser,
  publicAppUrl: string,
) {
  assertEmployee(employee);
  const request = await getAccountRequestById(database, requestId);
  if (!request) {
    throw new AppError("ACCOUNT_REQUEST_NOT_FOUND", "Account request not found.", 404);
  }
  if (request.status !== "approved") {
    throw new AppError(
      "SETUP_EMAIL_NOT_AVAILABLE",
      "A setup email is available only for an approved request.",
      409,
    );
  }

  const user = await database
    .prepare(
      `SELECT id FROM users
       WHERE account_request_id = ? AND status = 'setup_pending'
       LIMIT 1`,
    )
    .bind(requestId)
    .first<{ id: string }>();
  if (!user) {
    throw new AppError(
      "SETUP_EMAIL_NOT_AVAILABLE",
      "This account has already completed setup or is not active.",
      409,
    );
  }

  const now = nowInSeconds();
  const expiresAt = now + getPasswordSetupTtlSeconds();
  const rawToken = randomToken();
  const setupUrl = `${publicAppUrl}/setup-password#token=${encodeURIComponent(rawToken)}`;
  await database.batch([
    database
      .prepare(
        `UPDATE password_setup_tokens
         SET invalidated_at = ?
         WHERE user_id = ? AND used_at IS NULL AND invalidated_at IS NULL`,
      )
      .bind(now, user.id),
    database
      .prepare(
        `INSERT INTO password_setup_tokens (
          id, user_id, token_hash, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(createId(), user.id, await sha256(rawToken), expiresAt, now),
    database
      .prepare(
        `INSERT INTO approval_audit_records (
          id, account_request_id, actor_user_id, action, created_at
         ) VALUES (?, ?, ?, 'setup_email_resent', ?)`,
      )
      .bind(createId(), requestId, employee.id, now),
  ]);

  const delivery = await deliverEmail(approvedAccountEmail(request, setupUrl, expiresAt));
  await recordDelivery(database, request, "approved_setup", request.email, delivery);
  return { request, delivery };
}

export async function removeClientAccount(
  database: D1Database,
  clientId: string,
  employee: AuthenticatedUser,
  removalMessage: string,
) {
  assertEmployee(employee);
  const client = await getActiveClientAccount(database, clientId);
  if (!client) {
    throw new AppError(
      "CLIENT_ACCOUNT_NOT_FOUND",
      "The client account could not be found or has already been removed.",
      404,
    );
  }

  const auditId = createId();
  const now = nowInSeconds();
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO client_removal_audit_records (
          id, removed_client_user_id, client_email, actor_user_id,
          removal_message, created_at, email_status
         )
         SELECT ?, id, email, ?, ?, ?, 'pending'
         FROM users
         WHERE id = ? AND role = 'client' AND status <> 'disabled'`,
      )
      .bind(auditId, employee.id, removalMessage, now, clientId),
    database
      .prepare(
        `UPDATE users
         SET status = 'disabled',
             password_hash = NULL,
             password_set_at = NULL,
             updated_at = ?
         WHERE id = ?
           AND role = 'client'
           AND status <> 'disabled'
           AND EXISTS (
             SELECT 1
             FROM client_removal_audit_records
             WHERE id = ? AND removed_client_user_id = users.id
           )`,
      )
      .bind(now, clientId, auditId),
    database
      .prepare(
        `UPDATE sessions
         SET revoked_at = ?
         WHERE user_id = ?
           AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM client_removal_audit_records
             WHERE id = ? AND removed_client_user_id = sessions.user_id
           )`,
      )
      .bind(now, clientId, auditId),
    database
      .prepare(
        `UPDATE password_setup_tokens
         SET invalidated_at = ?
         WHERE user_id = ?
           AND used_at IS NULL
           AND invalidated_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM client_removal_audit_records
             WHERE id = ? AND removed_client_user_id = password_setup_tokens.user_id
           )`,
      )
      .bind(now, clientId, auditId),
  ]);

  if (changed(results[0]) !== 1 || changed(results[1]) !== 1) {
    throw new AppError(
      "CLIENT_ACCOUNT_ALREADY_REMOVED",
      "The client account has already been removed.",
      409,
    );
  }

  let delivery: EmailDeliveryResult;
  try {
    delivery = await deliverEmail(
      removedClientAccountEmail(client, removalMessage),
    );
  } catch {
    delivery = { status: "failed", errorCode: "TEMPLATE_CONFIGURATION" };
  }
  try {
    await updateClientRemovalEmailStatus(database, auditId, delivery);
  } catch (error) {
    console.error("[auth-client-removal] Delivery status update failed.", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }

  const audit: ClientRemovalAuditView = {
    id: auditId,
    removedClientAccountId: client.id,
    clientEmail: client.email,
    administratorAccountId: employee.id,
    removalMessage,
    createdAt: now,
  };
  return { client, audit, delivery };
}

export async function inspectPasswordSetupToken(database: D1Database, rawToken: string) {
  if (rawToken.length < 32 || rawToken.length > 256) return null;
  const token = await getSetupTokenByHash(database, await sha256(rawToken));
  const now = nowInSeconds();
  if (
    !token ||
    token.used_at ||
    token.invalidated_at ||
    token.expires_at <= now ||
    token.user_status !== "setup_pending"
  ) {
    return null;
  }
  return {
    email: token.email,
    fullName: token.full_name,
    expiresAt: token.expires_at,
    derivation: scryptPasswordDerivation(randomToken(PASSWORD_SALT_BYTES)),
  };
}

export async function completePasswordSetup(
  database: D1Database,
  rawToken: string,
  passwordSalt: string,
  passwordProof: string,
  request: Request,
) {
  const tokenHash = await sha256(rawToken);
  const token = await getSetupTokenByHash(database, tokenHash);
  const now = nowInSeconds();
  if (
    !token ||
    token.used_at ||
    token.invalidated_at ||
    token.expires_at <= now ||
    token.user_status !== "setup_pending"
  ) {
    throw new AppError(
      "INVALID_SETUP_TOKEN",
      "This password setup link is invalid, expired, or has already been used.",
      400,
    );
  }

  const passwordHash = await sealPasswordProof(
    token.user_id,
    scryptPasswordDerivation(passwordSalt),
    passwordProof,
    getPasswordPepper(),
  );
  const session = await buildSessionMaterial(token.user_id, request);

  try {
    await database.batch([
      database
        .prepare(
          `UPDATE password_setup_tokens
           SET used_at = ?, consumed_by_session_id = ?
           WHERE id = ?
             AND used_at IS NULL
             AND invalidated_at IS NULL
             AND expires_at > ?`,
        )
        .bind(now, session.id, token.id, now),
      database
        .prepare(
          `UPDATE users
           SET password_hash = ?,
               status = 'active',
               password_set_at = ?,
               updated_at = ?
           WHERE id = ?
             AND status = 'setup_pending'
             AND EXISTS (
               SELECT 1
               FROM password_setup_tokens
               WHERE id = ? AND consumed_by_session_id = ?
             )`,
        )
        .bind(passwordHash, now, now, token.user_id, token.id, session.id),
      database
        .prepare(
          `UPDATE sessions
           SET revoked_at = ?
           WHERE user_id = ? AND revoked_at IS NULL`,
        )
        .bind(now, token.user_id),
      database
        .prepare(
          `INSERT INTO sessions (
            id, user_id, token_hash, csrf_token_hash, expires_at,
            created_at, last_seen_at, ip_hash, user_agent_hash
           ) VALUES (
            ?,
            (
              SELECT user.id
              FROM users AS user
              INNER JOIN password_setup_tokens AS setup
                ON setup.user_id = user.id
              WHERE setup.id = ?
                AND setup.consumed_by_session_id = ?
                AND user.status = 'active'
              LIMIT 1
            ),
            ?, ?, ?, ?, ?, ?, ?
           )`,
        )
        .bind(
          session.id,
          token.id,
          session.id,
          session.tokenHash,
          session.csrfTokenHash,
          session.expiresAt,
          session.createdAt,
          session.createdAt,
          session.ipHash,
          session.userAgentHash,
        ),
      database
        .prepare(
          `UPDATE password_setup_tokens
           SET invalidated_at = ?
           WHERE user_id = ?
             AND id <> ?
             AND used_at IS NULL
             AND invalidated_at IS NULL`,
        )
        .bind(now, token.user_id, token.id),
    ]);
  } catch {
    throw new AppError(
      "INVALID_SETUP_TOKEN",
      "This password setup link is invalid, expired, or has already been used.",
      400,
    );
  }

  return {
    session: session satisfies SessionMaterial,
    user: {
      id: token.user_id,
      email: token.email,
      fullName: token.full_name,
      role: token.user_role,
    },
  };
}
