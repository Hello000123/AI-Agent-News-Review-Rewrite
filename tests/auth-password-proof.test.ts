import { describe, expect, it } from "vitest";

import { derivePasswordProof } from "@/lib/client/password-proof";
import {
  hashPassword,
  passwordDerivationFromHash,
  verifyPasswordProof,
  wrapLegacyPasswordHash,
} from "@/lib/server/auth/crypto";

const SECRET = "test-auth-secret-with-more-than-thirty-two-characters";

describe("server-peppered password proofs", () => {
  it("wraps a legacy scrypt hash without storing a reusable client proof", async () => {
    const legacyHash = await hashPassword("lettersletters");
    const passwordProof = legacyHash.split("$").at(-1) ?? "";
    const wrapped = await wrapLegacyPasswordHash(
      "test-user",
      legacyHash,
      SECRET,
    );

    expect(wrapped).toMatch(/^password-proof-v1\$scrypt\$/u);
    expect(wrapped).not.toContain(passwordProof);
    expect(passwordDerivationFromHash(wrapped ?? "")).toMatchObject({
      algorithm: "scrypt",
      cost: 32_768,
      blockSize: 8,
      parallelization: 3,
      keyLength: 32,
    });
    expect(
      await derivePasswordProof(
        "lettersletters",
        passwordDerivationFromHash(wrapped ?? "")!,
      ),
    ).toBe(passwordProof);
    expect(
      await verifyPasswordProof(
        "test-user",
        passwordProof,
        wrapped ?? "",
        SECRET,
      ),
    ).toBe(true);
    expect(
      await verifyPasswordProof(
        "test-user",
        Buffer.alloc(32, 7).toString("base64url"),
        wrapped ?? "",
        SECRET,
      ),
    ).toBe(false);
    expect(
      await verifyPasswordProof(
        "test-user",
        passwordProof,
        wrapped ?? "",
        `${SECRET}-different`,
      ),
    ).toBe(false);
  });

  it("preserves compatibility with existing PBKDF2 credentials", async () => {
    const salt = Buffer.alloc(16, 3).toString("base64url");
    const passwordProof = Buffer.alloc(32, 9).toString("base64url");
    const legacyHash = `pbkdf2-sha256$600000$${salt}$${passwordProof}`;
    const wrapped = await wrapLegacyPasswordHash(
      "legacy-user",
      legacyHash,
      SECRET,
    );

    expect(passwordDerivationFromHash(wrapped ?? "")).toEqual({
      algorithm: "pbkdf2-sha256",
      salt,
      iterations: 600_000,
      keyLength: 32,
    });
    expect(
      await verifyPasswordProof(
        "legacy-user",
        passwordProof,
        wrapped ?? "",
        SECRET,
      ),
    ).toBe(true);
  });
});
