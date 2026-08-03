import type { D1Database } from "@cloudflare/workers-types";

import {
  constantTimeEqualText,
  hmacSha256,
  passwordDerivationFromHash,
  verifyPasswordProof,
  wrapLegacyPasswordHash,
} from "@/lib/server/auth/crypto";
import { getPasswordPepper } from "@/lib/server/auth/config";
import {
  assertLoginAllowed,
  clearLoginFailures,
  recordLoginFailure,
} from "@/lib/server/auth/rate-limit";
import { getUserByEmail } from "@/lib/server/auth/repository";
import { createSession } from "@/lib/server/auth/sessions";
import { AppError } from "@/lib/server/errors";
import {
  PASSWORD_PROOF_BYTES,
  SCRYPT_BLOCK_SIZE,
  SCRYPT_COST,
  SCRYPT_PARALLELIZATION,
  type PasswordDerivation,
} from "@/lib/shared/auth-contracts";

async function fakePasswordDerivation(
  email: string,
  secret: string,
): Promise<PasswordDerivation> {
  const salt = (
    await hmacSha256(secret, `pressready-fake-password-salt:${email}`)
  ).slice(0, 22);
  return {
    algorithm: "scrypt",
    salt,
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    keyLength: PASSWORD_PROOF_BYTES,
  };
}

async function upgradeLegacyCredential(
  database: D1Database,
  user: { id: string; password_hash: string },
  secret: string,
) {
  const upgraded = await wrapLegacyPasswordHash(
    user.id,
    user.password_hash,
    secret,
  );
  if (!upgraded) return user.password_hash;
  await database
    .prepare(
      `UPDATE users
       SET password_hash = ?, updated_at = ?
       WHERE id = ? AND password_hash = ?`,
    )
    .bind(
      upgraded,
      Math.floor(Date.now() / 1_000),
      user.id,
      user.password_hash,
    )
    .run();
  return upgraded;
}

export async function prepareLoginPasswordChallenge(
  database: D1Database,
  email: string,
) {
  const secret = getPasswordPepper();
  const user = await getUserByEmail(database, email);
  if (user?.password_hash && user.status === "active") {
    const encodedHash = await upgradeLegacyCredential(
      database,
      { id: user.id, password_hash: user.password_hash },
      secret,
    );
    const derivation = passwordDerivationFromHash(encodedHash);
    if (derivation) return derivation;
  }
  return fakePasswordDerivation(email, secret);
}

async function performDummyPasswordProofCheck(
  email: string,
  passwordProof: string,
  secret: string,
) {
  const candidate = await hmacSha256(
    secret,
    `pressready-dummy-password-proof:${email}:${passwordProof}`,
  );
  return constantTimeEqualText(
    candidate,
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );
}

export async function loginWithPasswordProof(
  database: D1Database,
  email: string,
  passwordProof: string,
  request: Request,
) {
  await assertLoginAllowed(database, email, request);
  const secret = getPasswordPepper();
  const user = await getUserByEmail(database, email);
  const passwordMatches = user?.password_hash
    ? await verifyPasswordProof(
        user.id,
        passwordProof,
        user.password_hash,
        secret,
      )
    : await performDummyPasswordProofCheck(email, passwordProof, secret);

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
