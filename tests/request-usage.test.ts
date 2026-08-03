import { readFile } from "node:fs/promises";

import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";

import { listUserAccounts } from "@/lib/server/auth/repository";
import { incrementAgentRequestAttempt } from "@/lib/server/auth/request-usage";

async function executeSqlScript(database: D1Database, sql: string) {
  for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
}

describe("per-user agent request usage", () => {
  it("increments valid review and rewrite attempts atomically and exposes zero defaults", async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DB: "55555555-5555-5555-5555-555555555555" },
      cf: false,
    });

    try {
      const database = (await miniflare.getD1Database("DB")) as D1Database;
      const initial = await readFile(
        new URL("../migrations/0001_authentication.sql", import.meta.url),
        "utf8",
      );
      const usageMigration = await readFile(
        new URL("../migrations/0005_agent_request_usage.sql", import.meta.url),
        "utf8",
      );
      await executeSqlScript(database, initial);
      await executeSqlScript(database, usageMigration);

      const now = 1_700_000_000;
      await database
        .prepare(
          `INSERT INTO users (
            id, email, full_name, role, status, created_at, updated_at
           ) VALUES
            ('client-counted', 'counted@example.test', 'Counted Client', 'client', 'active', ?, ?),
            ('client-zero', 'zero@example.test', 'Zero Client', 'client', 'active', ?, ?)`,
        )
        .bind(now, now, now, now)
        .run();

      await Promise.all([
        incrementAgentRequestAttempt(database, "client-counted", "review"),
        incrementAgentRequestAttempt(database, "client-counted", "review"),
        incrementAgentRequestAttempt(database, "client-counted", "rewrite"),
      ]);

      const accounts = await listUserAccounts(database, "client");
      expect(accounts).toEqual([
        expect.objectContaining({
          id: "client-counted",
          reviewRequestCount: 2,
          rewriteRequestCount: 1,
        }),
        expect.objectContaining({
          id: "client-zero",
          reviewRequestCount: 0,
          rewriteRequestCount: 0,
        }),
      ]);
    } finally {
      await miniflare.dispose();
    }
  });
});
