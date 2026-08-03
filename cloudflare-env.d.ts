import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

declare global {
  interface CloudflareEnv {
    DB: D1Database;
    ACCOUNT_DOCUMENTS: R2Bucket;
  }
}

export {};
