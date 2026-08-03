import { describe, expect, it } from "vitest";

import {
  loginInputSchema,
  loginProofInputSchema,
  passwordSetupFormInputSchema,
  passwordSetupInputSchema,
  passwordValidationMessages,
} from "@/lib/shared/auth-contracts";

const token = "a-valid-looking-password-setup-token-value";
const passwordProof = "A".repeat(43);
const passwordSalt = "A".repeat(22);

function setupResult(password: string, confirmation = password) {
  return passwordSetupFormInputSchema.safeParse({
    token,
    newPassword: password,
    confirmPassword: confirmation,
  });
}

describe("password policy", () => {
  it.each([
    { length: 8, accepted: false },
    { length: 9, accepted: true },
    { length: 63, accepted: true },
    { length: 64, accepted: false },
  ])(
    "acceptance for a $length-character password is $accepted",
    ({ length, accepted }) => {
      expect(setupResult("a".repeat(length)).success).toBe(accepted);
      expect(
        loginInputSchema.safeParse({
          email: "person@example.test",
          password: "a".repeat(length),
        }).success,
      ).toBe(accepted);
    },
  );

  it("accepts letters-only passwords without numbers, symbols, or mixed case", () => {
    expect(setupResult("lettersletters").success).toBe(true);
    expect(setupResult("abcdefghij").success).toBe(true);
    expect(setupResult("ABCDEFGHIJ").success).toBe(true);
  });

  it("returns clear boundary and English-character messages", () => {
    expect(passwordValidationMessages("12345678")).toContain(
      "Password must contain more than 8 characters.",
    );
    expect(passwordValidationMessages("a".repeat(64))).toContain(
      "Password must contain fewer than 64 characters.",
    );
    expect(passwordValidationMessages("english字only")).toContain(
      "Password must use English keyboard characters only.",
    );
  });

  it("rejects a password and confirmation mismatch", () => {
    const result = setupResult("lettersletters", "differentletters");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path[0] === "confirmPassword" &&
            issue.message === "Passwords do not match.",
        ),
      ).toBe(true);
    }
  });

  it("enforces the same policy in backend login and setup request schemas", () => {
    expect(
      loginProofInputSchema.safeParse({
        email: "person@example.test",
        password: "abcdefghi",
        passwordProof,
      }).success,
    ).toBe(true);
    expect(
      loginProofInputSchema.safeParse({
        email: "person@example.test",
        password: "abcdefgh",
        passwordProof,
      }).success,
    ).toBe(false);
    expect(
      passwordSetupInputSchema.safeParse({
        token,
        newPassword: "abcdefghi",
        confirmPassword: "abcdefghi",
        passwordSalt,
        passwordProof,
      }).success,
    ).toBe(true);
  });
});
