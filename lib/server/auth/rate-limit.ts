import type { D1Database } from "@cloudflare/workers-types";

import { getAuthSecret } from "@/lib/server/auth/config";
import { hmacSha256, nowInSeconds } from "@/lib/server/auth/crypto";
import { getClientIp } from "@/lib/server/auth/http";
import { AppError } from "@/lib/server/errors";

const WINDOW_SECONDS = 15 * 60;
const BLOCK_SECONDS = 15 * 60;

interface RateLimitRow {
  attempt_count: number;
  window_started_at: number;
  blocked_until: number;
}

interface Bucket {
  key: string;
  scope: "email_ip" | "ip";
  maximumAttempts: number;
}

async function loginBuckets(email: string, request: Request): Promise<Bucket[]> {
  const ip = getClientIp(request);
  const secret = getAuthSecret();
  return [
    {
      key: await hmacSha256(secret, `login:email-ip:${email}:${ip}`),
      scope: "email_ip",
      maximumAttempts: 5,
    },
    {
      key: await hmacSha256(secret, `login:ip:${ip}`),
      scope: "ip",
      maximumAttempts: 20,
    },
  ];
}

export async function assertLoginAllowed(
  database: D1Database,
  email: string,
  request: Request,
) {
  const now = nowInSeconds();
  const buckets = await loginBuckets(email, request);
  for (const bucket of buckets) {
    const row = await database
      .prepare(
        `SELECT attempt_count, window_started_at, blocked_until
         FROM login_rate_limits
         WHERE bucket_key = ?
         LIMIT 1`,
      )
      .bind(bucket.key)
      .first<RateLimitRow>();
    if (row && row.blocked_until > now) {
      throw new AppError(
        "LOGIN_RATE_LIMITED",
        "Unable to sign in. Wait a few minutes and try again.",
        429,
      );
    }
  }
}

export async function recordLoginFailure(
  database: D1Database,
  email: string,
  request: Request,
) {
  const now = nowInSeconds();
  const cutoff = now - WINDOW_SECONDS;
  const blockedUntil = now + BLOCK_SECONDS;
  const buckets = await loginBuckets(email, request);
  await database.batch(
    buckets.map((bucket) =>
      database
        .prepare(
          `INSERT INTO login_rate_limits (
            bucket_key, scope, attempt_count, window_started_at, blocked_until, updated_at
          ) VALUES (?, ?, 1, ?, 0, ?)
          ON CONFLICT(bucket_key) DO UPDATE SET
            attempt_count = CASE
              WHEN login_rate_limits.window_started_at <= ? THEN 1
              ELSE login_rate_limits.attempt_count + 1
            END,
            window_started_at = CASE
              WHEN login_rate_limits.window_started_at <= ? THEN ?
              ELSE login_rate_limits.window_started_at
            END,
            blocked_until = CASE
              WHEN login_rate_limits.window_started_at <= ? THEN 0
              WHEN login_rate_limits.attempt_count + 1 >= ? THEN ?
              ELSE login_rate_limits.blocked_until
            END,
            updated_at = ?`,
        )
        .bind(
          bucket.key,
          bucket.scope,
          now,
          now,
          cutoff,
          cutoff,
          now,
          cutoff,
          bucket.maximumAttempts,
          blockedUntil,
          now,
        ),
    ),
  );
  await database
    .prepare("DELETE FROM login_rate_limits WHERE updated_at < ?")
    .bind(now - 24 * 60 * 60)
    .run();
}

export async function clearLoginFailures(
  database: D1Database,
  email: string,
  request: Request,
) {
  // A successful login clears only that email/IP pair. Keep the IP-wide
  // failure bucket so an attacker cannot reset aggregate throttling by signing
  // in to an account they control.
  const buckets = (await loginBuckets(email, request)).filter(
    (bucket) => bucket.scope === "email_ip",
  );
  await database.batch(
    buckets.map((bucket) =>
      database
        .prepare("DELETE FROM login_rate_limits WHERE bucket_key = ?")
        .bind(bucket.key),
    ),
  );
}
