import { z } from "zod";

import {
  MAX_REFERENCE_CHARS,
  MAX_REWRITE_HISTORY_ENTRIES,
  reviewResultSchema,
  rewriteHistoryEntrySchema,
  sourceSnapshotSchema,
} from "@/lib/shared/contracts";

export const REWRITE_SESSION_STORAGE_KEY = "pressready:rewrite-session:v1";

const completedRewriteTurnSchema = rewriteHistoryEntrySchema.extend({
  rewrittenText: z.string().trim().min(1).max(MAX_REFERENCE_CHARS),
});

export const persistedRewriteSessionSchema = z
  .object({
    version: z.literal(1),
    draft: z.string().max(MAX_REFERENCE_CHARS),
    sourceUrl: z.string().max(2_048),
    reviewedInputSignature: z.string().min(1).max(MAX_REFERENCE_CHARS * 2 + 5_000),
    reviewedSource: sourceSnapshotSchema,
    review: reviewResultSchema,
    message: z.string().max(2_000),
    passScore: z.number().min(0).max(100),
    history: z.array(completedRewriteTurnSchema).max(MAX_REWRITE_HISTORY_ENTRIES),
  })
  .strict();

export type CompletedRewriteTurn = z.infer<typeof completedRewriteTurnSchema>;
export type PersistedRewriteSession = z.infer<typeof persistedRewriteSessionSchema>;

function browserSessionStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadRewriteSession(): PersistedRewriteSession | null {
  const storage = browserSessionStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(REWRITE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = persistedRewriteSessionSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    storage.removeItem(REWRITE_SESSION_STORAGE_KEY);
    return null;
  } catch {
    return null;
  }
}

export function saveRewriteSession(session: PersistedRewriteSession) {
  const storage = browserSessionStorage();
  if (!storage) return false;

  const parsed = persistedRewriteSessionSchema.safeParse(session);
  if (!parsed.success) return false;

  try {
    storage.setItem(REWRITE_SESSION_STORAGE_KEY, JSON.stringify(parsed.data));
    return true;
  } catch {
    // Storage can be disabled or out of quota. Rewriting still works in memory.
    return false;
  }
}

export function clearRewriteSession() {
  const storage = browserSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(REWRITE_SESSION_STORAGE_KEY);
  } catch {
    // A blocked storage API must not prevent the user from resetting the UI.
  }
}
