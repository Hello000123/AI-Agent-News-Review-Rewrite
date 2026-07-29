import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { D1Database } from "@cloudflare/workers-types";

import { AppError } from "@/lib/server/errors";

let testDatabase: D1Database | undefined;

export function setDatabaseForTesting(database: D1Database | undefined) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The D1 test override is available only while running tests.");
  }
  testDatabase = database;
}

export function getDatabase() {
  if (testDatabase) return testDatabase;
  try {
    const database = getCloudflareContext().env.DB;
    if (!database) throw new Error("Missing DB binding.");
    return database;
  } catch (error) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      "The account service is temporarily unavailable.",
      503,
      { cause: error },
    );
  }
}

export function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/iu.test(error.message);
}
