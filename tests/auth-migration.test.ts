import { readFile } from "node:fs/promises";

import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";

async function executeSqlScript(database: D1Database, sql: string) {
  for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
}

describe("account request optional-fields migration", () => {
  it("preserves existing rows and foreign keys while making new fields nullable", async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DB: "22222222-2222-2222-2222-222222222222" },
      cf: false,
    });

    try {
      const database = (await miniflare.getD1Database("DB")) as D1Database;
      const initial = await readFile(
        new URL("../migrations/0001_authentication.sql", import.meta.url),
        "utf8",
      );
      await executeSqlScript(database, initial);
      await database
        .prepare(
          `INSERT INTO account_requests (
            id, email, full_name, phone, company, department, job_title,
            status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(
          "existing-request",
          "existing@example.test",
          "Existing Applicant",
          "+852 2345 6789",
          "Existing Company",
          "Existing Department",
          "Existing Role",
          1,
          1,
        )
        .run();
      await database
        .prepare(
          `INSERT INTO users (
            id, email, full_name, role, status, account_request_id, created_at, updated_at
           ) VALUES (?, ?, ?, 'client', 'setup_pending', ?, ?, ?)`,
        )
        .bind(
          "existing-user",
          "existing@example.test",
          "Existing Applicant",
          "existing-request",
          1,
          1,
        )
        .run();

      const migration = await readFile(
        new URL("../migrations/0002_account_request_optional_fields.sql", import.meta.url),
        "utf8",
      );
      await executeSqlScript(database, migration);

      const preserved = await database
        .prepare(
          `SELECT company, department, job_title, admin_message
           FROM account_requests WHERE id = ?`,
        )
        .bind("existing-request")
        .first<{
          company: string | null;
          department: string | null;
          job_title: string | null;
          admin_message: string | null;
        }>();
      expect(preserved).toEqual({
        company: "Existing Company",
        department: "Existing Department",
        job_title: "Existing Role",
        admin_message: null,
      });

      const tableInfo = await database
        .prepare("PRAGMA table_info(account_requests)")
        .all<{ name: string; notnull: number }>();
      const fields = new Map(
        tableInfo.results.map((column) => [column.name, column.notnull]),
      );
      expect(fields.get("company")).toBe(0);
      expect(fields.get("department")).toBe(0);
      expect(fields.get("job_title")).toBe(0);
      expect(fields.get("admin_message")).toBe(0);

      const removalMigration = await readFile(
        new URL("../migrations/0003_client_account_removals.sql", import.meta.url),
        "utf8",
      );
      await executeSqlScript(database, removalMigration);
      await database
        .prepare(
          `INSERT INTO users (
            id, email, full_name, role, status, created_at, updated_at
           ) VALUES (?, ?, ?, 'employee', 'active', ?, ?)`,
        )
        .bind(
          "existing-employee",
          "employee@example.test",
          "Existing Employee",
          1,
          1,
        )
        .run();
      await database
        .prepare(
          `INSERT INTO client_removal_audit_records (
            id, removed_client_user_id, client_email, actor_user_id,
            removal_message, created_at, email_status
           ) VALUES (?, ?, ?, ?, ?, ?, 'preview')`,
        )
        .bind(
          "removal-audit",
          "existing-user",
          "existing@example.test",
          "existing-employee",
          "Access ended.",
          2,
        )
        .run();
      await database
        .prepare("DELETE FROM users WHERE id = ?")
        .bind("existing-user")
        .run();
      expect(
        await database
          .prepare(
            `SELECT removed_client_user_id, client_email, actor_user_id,
                    removal_message, created_at
             FROM client_removal_audit_records
             WHERE id = ?`,
          )
          .bind("removal-audit")
          .first(),
      ).toEqual({
        removed_client_user_id: "existing-user",
        client_email: "existing@example.test",
        actor_user_id: "existing-employee",
        removal_message: "Access ended.",
        created_at: 2,
      });
      const auditColumns = await database
        .prepare("PRAGMA table_info(client_removal_audit_records)")
        .all<{ name: string }>();
      expect(auditColumns.results.map((column) => column.name)).not.toContain(
        "password_hash",
      );

      const attachmentMigration = await readFile(
        new URL("../migrations/0004_account_request_attachments.sql", import.meta.url),
        "utf8",
      );
      await executeSqlScript(database, attachmentMigration);
      await database
        .prepare(
          `INSERT INTO account_request_attachments (
            id, account_request_id, storage_key, original_name,
            content_type, size_bytes, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "attachment-1",
          "existing-request",
          "account-requests/opaque-key",
          "application.pdf",
          "application/pdf",
          1_024,
          3,
        )
        .run();
      expect(
        await database
          .prepare(
            `SELECT original_name, content_type, size_bytes
             FROM account_request_attachments
             WHERE account_request_id = ?`,
          )
          .bind("existing-request")
          .first(),
      ).toEqual({
        original_name: "application.pdf",
        content_type: "application/pdf",
        size_bytes: 1_024,
      });

      const foreignKeyProblems = await database
        .prepare("PRAGMA foreign_key_check")
        .all<Record<string, unknown>>();
      expect(foreignKeyProblems.results).toEqual([]);
    } finally {
      await miniflare.dispose();
    }
  });
});
