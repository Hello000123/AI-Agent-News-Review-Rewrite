import type { D1Database } from "@cloudflare/workers-types";

import { nowInSeconds } from "@/lib/server/auth/crypto";
import { getDatabase } from "@/lib/server/auth/database";

export type AgentRequestKind = "review" | "rewrite";

export async function incrementAgentRequestAttempt(
  database: D1Database,
  userId: string,
  kind: AgentRequestKind,
) {
  const reviewIncrement = kind === "review" ? 1 : 0;
  const rewriteIncrement = kind === "rewrite" ? 1 : 0;

  await database
    .prepare(
      `INSERT INTO agent_request_usage (
        user_id, review_request_count, rewrite_request_count, updated_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         review_request_count = review_request_count + excluded.review_request_count,
         rewrite_request_count = rewrite_request_count + excluded.rewrite_request_count,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, reviewIncrement, rewriteIncrement, nowInSeconds())
    .run();
}

export function recordAgentRequestAttempt(userId: string, kind: AgentRequestKind) {
  return incrementAgentRequestAttempt(getDatabase(), userId, kind);
}
