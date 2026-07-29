import type { D1Database } from "@cloudflare/workers-types";

import { createId, nowInSeconds } from "@/lib/server/auth/crypto";
import { isUniqueConstraintError } from "@/lib/server/auth/database";
import { AppError } from "@/lib/server/errors";
import type {
  AccountRequestInput,
  AccountRequestStatus,
  AccountRequestView,
  UserRole,
  UserStatus,
} from "@/lib/shared/auth-contracts";

interface AccountRequestRow {
  id: string;
  email: string;
  full_name: string;
  phone: string;
  company: string;
  department: string;
  job_title: string;
  status: AccountRequestStatus;
  decided_by: string | null;
  decided_at: number | null;
  rejection_reason: string | null;
  created_at: number;
  updated_at: number;
  actor_full_name: string | null;
  actor_email: string | null;
}

export interface UserAuthRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string | null;
  role: UserRole;
  status: UserStatus;
}

export interface SetupTokenRow {
  id: string;
  user_id: string;
  email: string;
  full_name: string;
  expires_at: number;
  used_at: number | null;
  invalidated_at: number | null;
  user_status: UserStatus;
}

function mapAccountRequest(row: AccountRequestRow): AccountRequestView {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    department: row.department,
    jobTitle: row.job_title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    rejectionReason: row.rejection_reason,
    decidedBy:
      row.decided_by && row.actor_full_name && row.actor_email
        ? {
            id: row.decided_by,
            fullName: row.actor_full_name,
            email: row.actor_email,
          }
        : null,
  };
}

const ACCOUNT_REQUEST_SELECT = `
  SELECT
    request.id,
    request.email,
    request.full_name,
    request.phone,
    request.company,
    request.department,
    request.job_title,
    request.status,
    request.decided_by,
    request.decided_at,
    request.rejection_reason,
    request.created_at,
    request.updated_at,
    actor.full_name AS actor_full_name,
    actor.email AS actor_email
  FROM account_requests AS request
  LEFT JOIN users AS actor ON actor.id = request.decided_by
`;

export async function createPendingAccountRequest(
  database: D1Database,
  input: AccountRequestInput,
) {
  const existingUser = await database
    .prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE LIMIT 1")
    .bind(input.email)
    .first<{ id: string }>();

  if (existingUser) {
    throw new AppError(
      "DUPLICATE_ACCOUNT_REQUEST",
      "An account request for this email is already pending or active.",
      409,
    );
  }

  const id = createId();
  const now = nowInSeconds();
  try {
    await database
      .prepare(
        `INSERT INTO account_requests (
          id, email, full_name, phone, company, department, job_title,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(
        id,
        input.email,
        input.fullName,
        input.phone,
        input.company,
        input.department,
        input.jobTitle,
        now,
        now,
      )
      .run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new AppError(
        "DUPLICATE_ACCOUNT_REQUEST",
        "An account request for this email is already pending or active.",
        409,
      );
    }
    throw error;
  }

  const created = await getAccountRequestById(database, id);
  if (!created) {
    throw new AppError(
      "ACCOUNT_REQUEST_FAILED",
      "The account request could not be submitted. Please try again.",
      500,
    );
  }
  return created;
}

export async function listAccountRequests(
  database: D1Database,
  status?: AccountRequestStatus,
) {
  const statement = status
    ? database
        .prepare(
          `${ACCOUNT_REQUEST_SELECT}
           WHERE request.status = ?
           ORDER BY request.created_at DESC
           LIMIT 200`,
        )
        .bind(status)
    : database.prepare(
        `${ACCOUNT_REQUEST_SELECT}
         ORDER BY request.created_at DESC
         LIMIT 200`,
      );
  const result = await statement.all<AccountRequestRow>();
  return result.results.map(mapAccountRequest);
}

export async function getAccountRequestById(database: D1Database, id: string) {
  const row = await database
    .prepare(`${ACCOUNT_REQUEST_SELECT} WHERE request.id = ? LIMIT 1`)
    .bind(id)
    .first<AccountRequestRow>();
  return row ? mapAccountRequest(row) : null;
}

export function getUserByEmail(database: D1Database, email: string) {
  return database
    .prepare(
      `SELECT id, email, full_name, password_hash, role, status
       FROM users
       WHERE email = ? COLLATE NOCASE
       LIMIT 1`,
    )
    .bind(email)
    .first<UserAuthRow>();
}

export function getSetupTokenByHash(database: D1Database, tokenHash: string) {
  return database
    .prepare(
      `SELECT
        token.id,
        token.user_id,
        token.expires_at,
        token.used_at,
        token.invalidated_at,
        user.email,
        user.full_name,
        user.status AS user_status
       FROM password_setup_tokens AS token
       INNER JOIN users AS user ON user.id = token.user_id
       WHERE token.token_hash = ?
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<SetupTokenRow>();
}

export async function recordEmailDelivery(
  database: D1Database,
  values: {
    accountRequestId: string | null;
    messageType: "new_request" | "approved_setup" | "rejected";
    recipient: string;
    status: "sent" | "preview" | "failed";
    providerMessageId?: string;
    errorCode?: string;
  },
) {
  const now = nowInSeconds();
  await database
    .prepare(
      `INSERT INTO email_delivery_records (
        id, account_request_id, message_type, recipient, status,
        provider_message_id, error_code, created_at, sent_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      createId(),
      values.accountRequestId,
      values.messageType,
      values.recipient,
      values.status,
      values.providerMessageId ?? null,
      values.errorCode ?? null,
      now,
      values.status === "sent" ? now : null,
    )
    .run();
}
