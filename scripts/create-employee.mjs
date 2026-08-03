import { spawn } from "node:child_process";
import { randomBytes, randomUUID, scrypt as nodeScrypt } from "node:crypto";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 3;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
export const PASSWORD_MIN_LENGTH = 9;
export const PASSWORD_MAX_LENGTH = 63;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const ENGLISH_KEYBOARD_CHARACTERS = /^[\u0020-\u007e]+$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export function normalizeEmail(value) {
  return value.trim().toLowerCase();
}

export function normalizeFullName(value) {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

export function passwordProblems(password) {
  const problems = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push("Password must contain more than 8 characters.");
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push("Password must contain fewer than 64 characters.");
  }
  if (password.length > 0 && !ENGLISH_KEYBOARD_CHARACTERS.test(password)) {
    problems.push("Password must use English keyboard characters only.");
  }
  return problems;
}

export function parseTargetOptions(
  args,
  configuredDatabase = process.env.AUTH_D1_DATABASE_NAME,
) {
  let target = "local";
  let explicitTarget;
  let databaseName = configuredDatabase?.trim() || "pressready-auth";

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--local" || value === "--remote") {
      const nextTarget = value.slice(2);
      if (explicitTarget && explicitTarget !== nextTarget) {
        throw new Error("Choose either --local or --remote, not both.");
      }
      explicitTarget = nextTarget;
      target = nextTarget;
    } else if (value === "--database") {
      databaseName = args[index + 1]?.trim();
      index += 1;
      if (!databaseName) throw new Error("--database requires a D1 database name.");
    } else if (value === "--help" || value === "-h") {
      return { help: true, target, databaseName };
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }

  if (!/^[a-zA-Z0-9_-]+$/u.test(databaseName)) {
    throw new Error("The D1 database name contains unsupported characters.");
  }
  return { help: false, target, databaseName };
}

function sqlString(value) {
  return `'${value.replace(/'/gu, "''")}'`;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await new Promise((resolvePromise, rejectPromise) => {
    nodeScrypt(
      password,
      salt,
      32,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, value) => {
        if (error) rejectPromise(error);
        else resolvePromise(value);
      },
    );
  });
  return [
    "scrypt-v1",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

function wranglerCliPath() {
  return join(
    process.cwd(),
    "node_modules",
    "wrangler",
    "wrangler-dist",
    "cli.js",
  );
}

function runWrangler(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", wranglerCliPath(), ...args],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function assertEmailAvailable(databaseName, target, email) {
  const query =
    "SELECT id FROM users WHERE email = " +
    `${sqlString(email)} COLLATE NOCASE LIMIT 1;`;
  const result = await runWrangler([
    "d1",
    "execute",
    databaseName,
    `--${target}`,
    "--command",
    query,
    "--json",
  ]);
  if (result.code !== 0) {
    throw new Error(
      `The ${target} D1 database could not be checked. Confirm Wrangler access and apply all migrations first.`,
    );
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error("Wrangler returned an unreadable response while checking the email.");
  }
  if (payload?.[0]?.results?.length) {
    throw new Error("An account with this email address already exists.");
  }
}

async function insertEmployee(databaseName, target, values) {
  const now = Math.floor(Date.now() / 1_000);
  const sql = `INSERT INTO users (
  id, email, full_name, password_hash, role, status, created_at, updated_at, password_set_at
) VALUES (
  ${sqlString(randomUUID())},
  ${sqlString(values.email)},
  ${sqlString(values.fullName)},
  ${sqlString(values.passwordHash)},
  'employee',
  'active',
  ${now},
  ${now},
  ${now}
);
`;

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "pressready-create-employee-"),
  );
  const sqlPath = join(temporaryDirectory, "create-employee.sql");
  try {
    await writeFile(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    const result = await runWrangler([
      "d1",
      "execute",
      databaseName,
      `--${target}`,
      "--file",
      sqlPath,
      "--yes",
      "--json",
    ]);
    if (result.code !== 0) {
      if (
        result.stderr.includes("UNIQUE constraint failed: users.email") ||
        result.stdout.includes("UNIQUE constraint failed: users.email")
      ) {
        throw new Error("An account with this email address already exists.");
      }
      throw new Error(
        `Employee creation failed in the ${target} D1 database. Confirm Wrangler access and that all migrations are applied.`,
      );
    }
  } finally {
    await unlink(sqlPath).catch(() => undefined);
    await rmdir(temporaryDirectory).catch(() => undefined);
  }
}

function printUsage(output = process.stdout) {
  output.write(
    "Use `npm run create-employee` for local D1 or " +
      "`npm run create-employee:remote` for Cloudflare D1.\n\n" +
      "Direct script usage: node scripts/create-employee.mjs " +
      "[--local|--remote] [--database pressready-auth]\n",
  );
}

export async function promptForAccount(input, output) {
  const reader = createInterface({ input, output });
  const lines = reader[Symbol.asyncIterator]();
  async function ask(prompt) {
    output.write(prompt);
    const next = await lines.next();
    if (next.done) throw new Error("Input ended before account creation was complete.");
    return next.value;
  }

  try {
    const email = normalizeEmail(await ask("Email address: "));
    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      throw new Error("Enter a valid email address.");
    }

    const fullName = normalizeFullName(await ask("User full name: "));
    if (
      !fullName ||
      fullName.length > 120 ||
      CONTROL_CHARACTERS.test(fullName)
    ) {
      throw new Error("Enter a full name of 120 characters or fewer.");
    }

    const password = await ask("Password: ");
    const confirmation = await ask("Confirm password: ");
    if (password !== confirmation) throw new Error("Passwords do not match.");
    const problems = passwordProblems(password);
    if (problems.length) throw new Error(problems.join(" "));
    return { email, fullName, password };
  } finally {
    reader.close();
  }
}

export async function main({
  args = process.argv.slice(2),
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const options = parseTargetOptions(args);
  if (options.help) {
    printUsage(output);
    return;
  }

  output.write(
    `Creating an employee account in ${options.target} D1 database "${options.databaseName}".\n`,
  );
  const values = await promptForAccount(input, output);
  await assertEmailAvailable(options.databaseName, options.target, values.email);
  const passwordHash = await hashPassword(values.password);
  await insertEmployee(options.databaseName, options.target, {
    email: values.email,
    fullName: values.fullName,
    passwordHash,
  });
  output.write(
    `Employee account created for ${values.fullName} (${values.email}).\n`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : "Employee creation failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
