import { scrypt as nodeScrypt } from "node:crypto";

import type { PasswordDerivation } from "@/lib/shared/auth-contracts";
import {
  PASSWORD_PROOF_BYTES,
  PASSWORD_SALT_BYTES,
  SCRYPT_BLOCK_SIZE,
  SCRYPT_COST,
  SCRYPT_PARALLELIZATION,
} from "@/lib/shared/auth-contracts";

const encoder = new TextEncoder();
const PBKDF2_ALGORITHM = "PBKDF2";
const LEGACY_PASSWORD_HASH_VERSION = "pbkdf2-sha256";
const SCRYPT_PASSWORD_HASH_VERSION = "scrypt-v1";
const PASSWORD_PROOF_HASH_VERSION = "password-proof-v1";
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const PASSWORD_HASH_BYTES = PASSWORD_PROOF_BYTES;
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

function canonicalBytes(value: string, expectedLength?: number) {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
    const bytes = base64UrlToBytes(value);
    if (
      (expectedLength !== undefined && bytes.length !== expectedLength) ||
      bytesToBase64Url(bytes) !== value
    ) {
      return null;
    }
    return bytes;
  } catch {
    return null;
  }
}

function validSalt(value: string) {
  const bytes = canonicalBytes(value);
  return bytes && bytes.length >= PASSWORD_SALT_BYTES ? bytes : null;
}

function derivationDescriptor(derivation: PasswordDerivation) {
  if (derivation.algorithm === "scrypt") {
    return [
      derivation.algorithm,
      derivation.cost,
      derivation.blockSize,
      derivation.parallelization,
      derivation.keyLength,
      derivation.salt,
    ].join(":");
  }
  return [
    derivation.algorithm,
    derivation.iterations,
    derivation.keyLength,
    derivation.salt,
  ].join(":");
}

function passwordProofMaterial(
  userId: string,
  derivation: PasswordDerivation,
  passwordProof: string,
) {
  return [
    "pressready-password-proof",
    PASSWORD_PROOF_HASH_VERSION,
    userId,
    derivationDescriptor(derivation),
    passwordProof,
  ].join(":");
}

function encodeProofCredential(
  derivation: PasswordDerivation,
  passwordProofMac: string,
) {
  if (derivation.algorithm === "scrypt") {
    return [
      PASSWORD_PROOF_HASH_VERSION,
      derivation.algorithm,
      derivation.cost,
      derivation.blockSize,
      derivation.parallelization,
      derivation.keyLength,
      derivation.salt,
      passwordProofMac,
    ].join("$");
  }
  return [
    PASSWORD_PROOF_HASH_VERSION,
    derivation.algorithm,
    derivation.iterations,
    derivation.keyLength,
    derivation.salt,
    passwordProofMac,
  ].join("$");
}

function parseScryptDerivation(
  costRaw: string,
  blockSizeRaw: string,
  parallelizationRaw: string,
  keyLengthRaw: string,
  salt: string,
): PasswordDerivation | null {
  if (
    Number(costRaw) !== SCRYPT_COST ||
    Number(blockSizeRaw) !== SCRYPT_BLOCK_SIZE ||
    Number(parallelizationRaw) !== SCRYPT_PARALLELIZATION ||
    Number(keyLengthRaw) !== PASSWORD_PROOF_BYTES ||
    !validSalt(salt)
  ) {
    return null;
  }
  return {
    algorithm: "scrypt",
    salt,
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    keyLength: PASSWORD_PROOF_BYTES,
  };
}

function parsePbkdf2Derivation(
  iterationsRaw: string,
  keyLengthRaw: string,
  salt: string,
): PasswordDerivation | null {
  const iterations = Number(iterationsRaw);
  if (
    !Number.isInteger(iterations) ||
    iterations < 100_000 ||
    iterations > 2_000_000 ||
    Number(keyLengthRaw) !== PASSWORD_PROOF_BYTES ||
    !validSalt(salt)
  ) {
    return null;
  }
  return {
    algorithm: "pbkdf2-sha256",
    salt,
    iterations,
    keyLength: PASSWORD_PROOF_BYTES,
  };
}

function parseProofCredential(encodedHash: string) {
  const parts = encodedHash.split("$");
  if (
    parts[0] !== PASSWORD_PROOF_HASH_VERSION ||
    !canonicalBytes(parts.at(-1) ?? "", PASSWORD_PROOF_BYTES)
  ) {
    return null;
  }
  if (parts[1] === "scrypt" && parts.length === 8) {
    const derivation = parseScryptDerivation(
      parts[2],
      parts[3],
      parts[4],
      parts[5],
      parts[6],
    );
    return derivation
      ? { derivation, passwordProofMac: parts[7] }
      : null;
  }
  if (parts[1] === "pbkdf2-sha256" && parts.length === 6) {
    const derivation = parsePbkdf2Derivation(parts[2], parts[3], parts[4]);
    return derivation
      ? { derivation, passwordProofMac: parts[5] }
      : null;
  }
  return null;
}

function parseLegacyCredential(encodedHash: string) {
  const parts = encodedHash.split("$");
  if (parts[0] === SCRYPT_PASSWORD_HASH_VERSION && parts.length === 6) {
    const derivation = parseScryptDerivation(
      parts[1],
      parts[2],
      parts[3],
      String(PASSWORD_PROOF_BYTES),
      parts[4],
    );
    return derivation && canonicalBytes(parts[5], PASSWORD_PROOF_BYTES)
      ? { derivation, passwordProof: parts[5] }
      : null;
  }
  if (parts[0] === LEGACY_PASSWORD_HASH_VERSION && parts.length === 4) {
    const derivation = parsePbkdf2Derivation(
      parts[1],
      String(PASSWORD_PROOF_BYTES),
      parts[2],
    );
    return derivation && canonicalBytes(parts[3], PASSWORD_PROOF_BYTES)
      ? { derivation, passwordProof: parts[3] }
      : null;
  }
  return null;
}

export function passwordDerivationFromHash(encodedHash: string) {
  return (
    parseProofCredential(encodedHash)?.derivation ??
    parseLegacyCredential(encodedHash)?.derivation ??
    null
  );
}

export async function sealPasswordProof(
  userId: string,
  derivation: PasswordDerivation,
  passwordProof: string,
  secret: string,
) {
  if (
    !userId ||
    !validSalt(derivation.salt) ||
    !canonicalBytes(passwordProof, PASSWORD_PROOF_BYTES)
  ) {
    throw new Error("Invalid password proof material.");
  }
  const passwordProofMac = await hmacSha256(
    secret,
    passwordProofMaterial(userId, derivation, passwordProof),
  );
  return encodeProofCredential(derivation, passwordProofMac);
}

export async function wrapLegacyPasswordHash(
  userId: string,
  encodedHash: string,
  secret: string,
) {
  const legacy = parseLegacyCredential(encodedHash);
  if (!legacy) return null;
  return sealPasswordProof(
    userId,
    legacy.derivation,
    legacy.passwordProof,
    secret,
  );
}

export async function verifyPasswordProof(
  userId: string,
  passwordProof: string,
  encodedHash: string,
  secret: string,
) {
  const credential = parseProofCredential(encodedHash);
  if (!credential) return false;
  try {
    const candidate = await sealPasswordProof(
      userId,
      credential.derivation,
      passwordProof,
      secret,
    );
    return constantTimeEqualText(candidate, encodedHash);
  } catch {
    return false;
  }
}

async function deriveLegacyPassword(
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

function derivePassword(password: string, salt: Uint8Array) {
  return new Promise<Uint8Array>((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      PASSWORD_HASH_BYTES,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derived) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(new Uint8Array(derived));
      },
    );
  });
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
  const derived = await derivePassword(password, salt);
  return [
    SCRYPT_PASSWORD_HASH_VERSION,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    bytesToBase64Url(salt),
    bytesToBase64Url(derived),
  ].join("$");
}

async function verifyScryptPassword(password: string, encodedHash: string) {
  const [version, costRaw, blockSizeRaw, parallelizationRaw, saltRaw, expectedRaw, extra] =
    encodedHash.split("$");
  if (
    version !== SCRYPT_PASSWORD_HASH_VERSION ||
    extra !== undefined ||
    Number(costRaw) !== SCRYPT_COST ||
    Number(blockSizeRaw) !== SCRYPT_BLOCK_SIZE ||
    Number(parallelizationRaw) !== SCRYPT_PARALLELIZATION
  ) {
    return false;
  }

  const salt = base64UrlToBytes(saltRaw);
  const expected = base64UrlToBytes(expectedRaw);
  if (salt.length !== PASSWORD_SALT_BYTES || expected.length !== PASSWORD_HASH_BYTES) {
    return false;
  }
  const actual = await derivePassword(password, salt);
  return constantTimeEqual(actual, expected);
}

async function verifyLegacyPassword(password: string, encodedHash: string) {
  const [version, iterationsRaw, saltRaw, expectedRaw, extra] = encodedHash.split("$");
  const iterations = Number(iterationsRaw);
  if (
    version !== LEGACY_PASSWORD_HASH_VERSION ||
    extra !== undefined ||
    !Number.isInteger(iterations) ||
    iterations < 100_000 ||
    iterations > 2_000_000
  ) {
    return false;
  }

  const salt = base64UrlToBytes(saltRaw);
  const expected = base64UrlToBytes(expectedRaw);
  if (salt.length < PASSWORD_SALT_BYTES || expected.length !== PASSWORD_HASH_BYTES) {
    return false;
  }
  const actual = await deriveLegacyPassword(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

export function passwordHashNeedsUpgrade(encodedHash: string) {
  return !encodedHash.startsWith(`${PASSWORD_PROOF_HASH_VERSION}$`);
}

export async function verifyPassword(password: string, encodedHash: string) {
  try {
    if (encodedHash.startsWith(`${SCRYPT_PASSWORD_HASH_VERSION}$`)) {
      return await verifyScryptPassword(password, encodedHash);
    }
    if (encodedHash.startsWith(`${LEGACY_PASSWORD_HASH_VERSION}$`)) {
      return await verifyLegacyPassword(password, encodedHash);
    }
  } catch {
    await performDummyPasswordCheck(password);
    return false;
  }

  await performDummyPasswordCheck(password);
  return false;
}

export async function performDummyPasswordCheck(password: string) {
  try {
    const derived = await derivePassword(password, DUMMY_SALT);
    return constantTimeEqual(derived, new Uint8Array(PASSWORD_HASH_BYTES));
  } catch {
    // Authentication must fail closed even if the runtime's KDF is unavailable.
    await sha256(`password-check:${password}`);
    return false;
  }
}
