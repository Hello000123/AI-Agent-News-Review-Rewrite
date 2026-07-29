import type { D1Database } from "@cloudflare/workers-types";

import {
  performDummyPasswordCheck,
  verifyPassword,
} from "@/lib/server/auth/crypto";
import {
  assertLoginAllowed,
  clearLoginFailures,
  recordLoginFailure,
} from "@/lib/server/auth/rate-limit";
import { getUserByEmail } from "@/lib/server/auth/repository";
import { createSession } from "@/lib/server/auth/sessions";
import { AppError } from "@/lib/server/errors";

export async function loginWithPassword(
  database: D1Database,
  email: string,
  password: string,
  request: Request,
) {
  await assertLoginAllowed(database, email, request);
  const user = await getUserByEmail(database, email);
  const passwordMatches = user?.password_hash
    ? await verifyPassword(password, user.password_hash)
    : await performDummyPasswordCheck(password);

  if (
    !user ||
    !passwordMatches ||
    user.status !== "active" ||
    !user.password_hash
  ) {
    await recordLoginFailure(database, email, request);
    throw new AppError(
      "INVALID_CREDENTIALS",
      "The email address or password is incorrect.",
      401,
    );
  }

  await clearLoginFailures(database, email, request);
  const session = await createSession(database, user.id, request);
  return {
    session,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
    },
  };
}
