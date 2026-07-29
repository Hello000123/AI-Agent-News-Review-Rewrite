import type { D1Database } from "@cloudflare/workers-types";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  constantTimeEqualText,
  createId,
  hmacSha256,
  nowInSeconds,
  randomToken,
  sha256,
} from "@/lib/server/auth/crypto";
import {
  getAuthSecret,
  getSessionTtlSeconds,
  isProductionEnvironment,
} from "@/lib/server/auth/config";
import { getClientIp } from "@/lib/server/auth/http";
import type { AuthenticatedUser, UserRole } from "@/lib/shared/auth-contracts";

export const SESSION_COOKIE_NAME = "pressready_session";
export const CSRF_COOKIE_NAME = "pressready_csrf";

interface SessionRow {
  session_id: string;
  user_id: string;
  email: string;
  full_name: string;
  role: UserRole;
  csrf_token_hash: string;
  expires_at: number;
  last_seen_at: number;
}

export interface AuthSession {
  id: string;
  user: AuthenticatedUser;
  csrfTokenHash: string;
  expiresAt: number;
}

export interface SessionMaterial {
  id: string;
  userId: string;
  rawToken: string;
  tokenHash: string;
  rawCsrfToken: string;
  csrfTokenHash: string;
  createdAt: number;
  expiresAt: number;
  ipHash: string;
  userAgentHash: string;
}

function parseCookieHeader(header: string | null) {
  const values = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      values.set(name, decodeURIComponent(value));
    } catch {
      // Ignore malformed cookie values.
    }
  }
  return values;
}

export function cookieValue(request: Request, name: string) {
  return parseCookieHeader(request.headers.get("cookie")).get(name);
}

export async function buildSessionMaterial(userId: string, request: Request) {
  const createdAt = nowInSeconds();
  const rawToken = randomToken();
  const rawCsrfToken = randomToken();
  const secret = getAuthSecret();
  return {
    id: createId(),
    userId,
    rawToken,
    tokenHash: await sha256(rawToken),
    rawCsrfToken,
    csrfTokenHash: await sha256(rawCsrfToken),
    createdAt,
    expiresAt: createdAt + getSessionTtlSeconds(),
    ipHash: await hmacSha256(secret, `ip:${getClientIp(request)}`),
    userAgentHash: await hmacSha256(
      secret,
      `ua:${request.headers.get("user-agent")?.slice(0, 500) ?? "unknown"}`,
    ),
  } satisfies SessionMaterial;
}

export async function createSession(
  database: D1Database,
  userId: string,
  request: Request,
) {
  const material = await buildSessionMaterial(userId, request);
  const existingRawToken = cookieValue(request, SESSION_COOKIE_NAME);
  const statements = [];
  if (existingRawToken) {
    statements.push(
      database
        .prepare(
          "UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
        )
        .bind(material.createdAt, await sha256(existingRawToken)),
    );
  }
  statements.push(
    database
      .prepare(
        `INSERT INTO sessions (
          id, user_id, token_hash, csrf_token_hash, expires_at,
          created_at, last_seen_at, ip_hash, user_agent_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        material.id,
        material.userId,
        material.tokenHash,
        material.csrfTokenHash,
        material.expiresAt,
        material.createdAt,
        material.createdAt,
        material.ipHash,
        material.userAgentHash,
      ),
  );
  await database.batch(statements);
  return material;
}

export async function findSessionByRawToken(
  database: D1Database,
  rawToken: string | undefined,
) {
  if (!rawToken || rawToken.length > 256) return null;
  const now = nowInSeconds();
  const tokenHash = await sha256(rawToken);
  const row = await database
    .prepare(
      `SELECT
        session.id AS session_id,
        session.user_id,
        session.csrf_token_hash,
        session.expires_at,
        session.last_seen_at,
        user.email,
        user.full_name,
        user.role
       FROM sessions AS session
       INNER JOIN users AS user ON user.id = session.user_id
       WHERE session.token_hash = ?
         AND session.revoked_at IS NULL
         AND session.expires_at > ?
         AND user.status = 'active'
         AND user.password_hash IS NOT NULL
       LIMIT 1`,
    )
    .bind(tokenHash, now)
    .first<SessionRow>();

  if (!row) {
    await database
      .prepare(
        `UPDATE sessions
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE token_hash = ? AND expires_at <= ?`,
      )
      .bind(now, tokenHash, now)
      .run();
    return null;
  }

  if (row.last_seen_at < now - 300) {
    await database
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
      .bind(now, row.session_id)
      .run();
  }

  return {
    id: row.session_id,
    user: {
      id: row.user_id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
    },
    csrfTokenHash: row.csrf_token_hash,
    expiresAt: row.expires_at,
  } satisfies AuthSession;
}

export function getRequestSession(database: D1Database, request: Request) {
  return findSessionByRawToken(
    database,
    cookieValue(request, SESSION_COOKIE_NAME),
  );
}

export async function getPageSession(database: D1Database) {
  const cookieStore = await cookies();
  return findSessionByRawToken(
    database,
    cookieStore.get(SESSION_COOKIE_NAME)?.value,
  );
}

function secureCookie(request: Request) {
  return isProductionEnvironment() || new URL(request.url).protocol === "https:";
}

export function setSessionCookies(
  response: NextResponse,
  material: SessionMaterial,
  request: Request,
) {
  const secure = secureCookie(request);
  const maxAge = Math.max(0, material.expiresAt - nowInSeconds());
  response.cookies.set(SESSION_COOKIE_NAME, material.rawToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  response.cookies.set(CSRF_COOKIE_NAME, material.rawCsrfToken, {
    httpOnly: false,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge,
  });
}

export function clearSessionCookies(response: NextResponse, request: Request) {
  const secure = secureCookie(request);
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });
  response.cookies.set(CSRF_COOKIE_NAME, "", {
    httpOnly: false,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });
}

export async function revokeRequestSession(database: D1Database, request: Request) {
  const rawToken = cookieValue(request, SESSION_COOKIE_NAME);
  if (!rawToken) return;
  await database
    .prepare(
      "UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
    )
    .bind(nowInSeconds(), await sha256(rawToken))
    .run();
}

export async function validateSessionCsrf(request: Request, session: AuthSession) {
  const headerToken = request.headers.get("x-csrf-token")?.trim();
  const cookieToken = cookieValue(request, CSRF_COOKIE_NAME);
  if (!headerToken || !cookieToken || !constantTimeEqualText(headerToken, cookieToken)) {
    return false;
  }
  const suppliedHash = await sha256(headerToken);
  return constantTimeEqualText(suppliedHash, session.csrfTokenHash);
}
