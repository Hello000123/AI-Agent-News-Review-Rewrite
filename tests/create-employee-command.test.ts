import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  normalizeEmail,
  parseTargetOptions,
  passwordProblems,
  promptForAccount,
} from "../scripts/create-employee.mjs";

function terminalIo(lines: string[]) {
  let output = "";
  return {
    input: Readable.from(`${lines.join("\n")}\n`),
    output: new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }),
    text: () => output,
  };
}

describe("create-employee command", () => {
  it("provides unambiguous npm commands for local and remote D1", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["create-employee"]).toBe(
      "node scripts/create-employee.mjs --local",
    );
    expect(packageJson.scripts?.["create-employee:remote"]).toBe(
      "node scripts/create-employee.mjs --remote",
    );
  });

  it("prompts for email, full name, password, and confirmation in order", async () => {
    const terminal = terminalIo([
      " Employee@Example.Test ",
      "  Employee   Person  ",
      "lettersonly",
      "lettersonly",
    ]);
    const result = await promptForAccount(terminal.input, terminal.output);

    expect(result).toEqual({
      email: "employee@example.test",
      fullName: "Employee Person",
      password: "lettersonly",
    });
    expect(terminal.text()).toBe(
      "Email address: User full name: Password: Confirm password: ",
    );
  });

  it("rejects invalid emails, password lengths, and mismatched confirmation", async () => {
    const invalidEmail = terminalIo(["not-an-email"]);
    await expect(
      promptForAccount(invalidEmail.input, invalidEmail.output),
    ).rejects.toThrow("Enter a valid email address.");

    const shortPassword = terminalIo([
      "employee@example.test",
      "Employee Person",
      "12345678",
      "12345678",
    ]);
    await expect(
      promptForAccount(shortPassword.input, shortPassword.output),
    ).rejects.toThrow("Password must contain more than 8 characters.");

    const mismatch = terminalIo([
      "employee@example.test",
      "Employee Person",
      "lettersonly",
      "differentletters",
    ]);
    await expect(
      promptForAccount(mismatch.input, mismatch.output),
    ).rejects.toThrow("Passwords do not match.");
  });

  it("uses the login email normalization and requires explicit remote targeting", () => {
    expect(normalizeEmail(" Employee@Example.COM ")).toBe(
      "employee@example.com",
    );
    expect(parseTargetOptions([])).toMatchObject({
      target: "local",
      databaseName: "pressready-auth",
    });
    expect(parseTargetOptions(["--remote"])).toMatchObject({
      target: "remote",
    });
    expect(() =>
      parseTargetOptions(["--local", "--remote"]),
    ).toThrow("Choose either --local or --remote");
  });

  it("uses the same 9-to-63 English-keyboard-character password policy", () => {
    expect(passwordProblems("a".repeat(8))).not.toHaveLength(0);
    expect(passwordProblems("a".repeat(9))).toEqual([]);
    expect(passwordProblems("a".repeat(63))).toEqual([]);
    expect(passwordProblems("a".repeat(64))).not.toHaveLength(0);
    expect(passwordProblems("lettersonly")).toEqual([]);
    expect(passwordProblems("letters字only")).toContain(
      "Password must use English keyboard characters only.",
    );
  });
});
