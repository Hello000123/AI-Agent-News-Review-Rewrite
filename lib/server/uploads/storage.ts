import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { R2Bucket } from "@cloudflare/workers-types";

import { AppError } from "@/lib/server/errors";

let testBucket: R2Bucket | undefined;

export function setAccountDocumentBucketForTesting(
  bucket: R2Bucket | undefined,
) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The R2 test override is available only while running tests.");
  }
  testBucket = bucket;
}

export function getAccountDocumentBucket() {
  if (testBucket) return testBucket;
  try {
    const bucket = getCloudflareContext().env.ACCOUNT_DOCUMENTS;
    if (!bucket) throw new Error("Missing ACCOUNT_DOCUMENTS binding.");
    return bucket;
  } catch (error) {
    throw new AppError(
      "DOCUMENT_STORAGE_UNAVAILABLE",
      "Supporting-document storage is temporarily unavailable. Try again later.",
      503,
      { cause: error },
    );
  }
}
