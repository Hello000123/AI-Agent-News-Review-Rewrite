const encoder = new TextEncoder();
const PBKDF2_ALGORITHM = "PBKDF2";
const PASSWORD_HASH_VERSION = "pbkdf2-sha256";
const PASSWORD_HASH_ITERATIONS = 600_000;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 32;
const DUMMY_SALT = new Uint8Array([
  91, 157, 12, 224, 64, 75, 209, 48, 170, 90, 33, 198, 72, 119, 52, 6,
]);

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function nowInSeconds() {
  return Math.floor(Date.now() / 1_000);
}

export function createId() {
  return crypto.randomUUID();
}

export function randomToken(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64Url(bytes);
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function hmacSha256(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function derivePassword(
  password: string,
  salt: Uint8Array,
  iterations: number,
) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    PBKDF2_ALGORITHM,
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: PBKDF2_ALGORITHM,
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations,
    },
    keyMaterial,
    PASSWORD_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  const maximumLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximumLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function constantTimeEqualText(left: string, right: string) {
  return constantTimeEqual(encoder.encode(left), encoder.encode(right));
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const derived = await derivePassword(password, salt, PASSWORD_HASH_ITERATIONS);
  return [
    PASSWORD_HASH_VERSION,
    PASSWORD_HASH_ITERATIONS,
    bytesToBase64Url(salt),
    bytesToBase64Url(derived),
  ].join("$");
}

export async function verifyPassword(password: string, encodedHash: string) {
  const [version, iterationsRaw, saltRaw, expectedRaw, extra] = encodedHash.split("$");
  const iterations = Number(iterationsRaw);
  if (
    version !== PASSWORD_HASH_VERSION ||
    extra !== undefined ||
    !Number.isInteger(iterations) ||
    iterations < 100_000 ||
    iterations > 2_000_000
  ) {
    await performDummyPasswordCheck(password);
    return false;
  }

  try {
    const salt = base64UrlToBytes(saltRaw);
    const expected = base64UrlToBytes(expectedRaw);
    if (salt.length < 16 || expected.length !== PASSWORD_HASH_BYTES) {
      await performDummyPasswordCheck(password);
      return false;
    }
    const actual = await derivePassword(password, salt, iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    await performDummyPasswordCheck(password);
    return false;
  }
}

export async function performDummyPasswordCheck(password: string) {
  const derived = await derivePassword(password, DUMMY_SALT, PASSWORD_HASH_ITERATIONS);
  return constantTimeEqual(derived, new Uint8Array(PASSWORD_HASH_BYTES));
}
