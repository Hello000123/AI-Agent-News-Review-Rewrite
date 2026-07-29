import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PBKDF2_ITERATIONS = 600_000;
const encoder = new TextEncoder();

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "Usage: npm run employee:prepare -- --email employee@example.com --name \"Employee Name\" [--local|--remote]\n",
  );
  process.exitCode = 1;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    material,
    256,
  );
  return [
    "pbkdf2-sha256",
    PBKDF2_ITERATIONS,
    bytesToBase64Url(salt),
    bytesToBase64Url(new Uint8Array(bits)),
  ].join("$");
}

function passwordProblems(password) {
  const problems = [];
  if (password.length < 12) problems.push("Password must contain at least 12 characters.");
  if (password.length > 128) problems.push("Password must contain at most 128 characters.");
  const groups = [
    /[a-z]/u.test(password),
    /[A-Z]/u.test(password),
    /\d/u.test(password),
    /[^\p{L}\p{N}\s]/u.test(password),
  ].filter(Boolean).length;
  if (groups < 3) {
    problems.push(
      "Password must use at least three of lowercase, uppercase, numbers, and symbols.",
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(password)) {
    problems.push("Password contains an unsupported control character.");
  }
  return problems;
}

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdin.setRawMode) {
      reject(
        new Error(
          "A TTY is required for the hidden password prompt. Run this command in an interactive terminal.",
        ),
      );
      return;
    }
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let value = "";

    function finish(error) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    }

    function onData(chunk) {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish(new Error("Cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    }
    process.stdin.on("data", onData);
  });
}

function sqlString(value) {
  return `'${value.replace(/'/gu, "''")}'`;
}

const email = argument("--email")?.toLowerCase();
const fullName = argument("--name")?.normalize("NFC").trim().replace(/\s+/gu, " ");
const remote = process.argv.includes("--remote");
const local = process.argv.includes("--local");

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
  usage("Provide a valid --email value.");
} else if (
  !fullName ||
  fullName.length > 120 ||
  /[\u0000-\u001f\u007f]/u.test(fullName)
) {
  usage("Provide a valid --name value of 120 characters or fewer.");
} else if (remote && local) {
  usage("Choose either --local or --remote, not both.");
} else {
  try {
    const password = await readHidden("New employee password: ");
    const confirmation = await readHidden("Confirm employee password: ");
    if (password !== confirmation) throw new Error("Passwords do not match.");
    const problems = passwordProblems(password);
    if (problems.length) throw new Error(problems.join(" "));

    const now = Math.floor(Date.now() / 1_000);
    const passwordHash = await hashPassword(password);
    const sql = `INSERT INTO users (
  id, email, full_name, password_hash, role, status, created_at, updated_at, password_set_at
) VALUES (
  ${sqlString(crypto.randomUUID())},
  ${sqlString(email)},
  ${sqlString(fullName)},
  ${sqlString(passwordHash)},
  'employee',
  'active',
  ${now},
  ${now},
  ${now}
);
`;

    const bootstrapDirectory = join(process.cwd(), ".wrangler", "bootstrap");
    const sqlPath = join(bootstrapDirectory, "create-employee.sql");
    await mkdir(bootstrapDirectory, { recursive: true });
    await writeFile(sqlPath, sql, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const databaseName = process.env.AUTH_D1_DATABASE_NAME?.trim() || "pressready-auth";
    const displayPath = ".wrangler\\bootstrap\\create-employee.sql";
    process.stdout.write(
      `Employee SQL prepared for ${email}.\n` +
      `Apply it with:\n\n` +
      `npx wrangler d1 execute ${databaseName} ${remote ? "--remote" : "--local"} --file "${displayPath}"\n\n` +
      `After Wrangler succeeds, delete ${displayPath}; it contains a password hash.\n`,
    );
  } catch (error) {
    const message =
      error instanceof Error && "code" in error && error.code === "EEXIST"
        ? "A pending employee SQL file already exists. Apply or delete .wrangler\\bootstrap\\create-employee.sql before preparing another employee."
        : error instanceof Error
          ? error.message
          : "Employee preparation failed.";
    process.stderr.write(
      `${message}\n`,
    );
    process.exitCode = 1;
  }
}
