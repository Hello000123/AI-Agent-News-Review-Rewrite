"use client";

import { scrypt } from "scrypt-js";

import {
  PASSWORD_PROOF_BYTES,
  SCRYPT_BLOCK_SIZE,
  SCRYPT_COST,
  SCRYPT_PARALLELIZATION,
  type PasswordDerivation,
} from "@/lib/shared/auth-contracts";

const encoder = new TextEncoder();

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("The password challenge is invalid.");
  }
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function assertDerivation(derivation: PasswordDerivation) {
  const salt = base64UrlToBytes(derivation.salt);
  if (salt.length < 16 || derivation.keyLength !== PASSWORD_PROOF_BYTES) {
    throw new Error("The password challenge is invalid.");
  }
  if (derivation.algorithm === "scrypt") {
    if (
      derivation.cost !== SCRYPT_COST ||
      derivation.blockSize !== SCRYPT_BLOCK_SIZE ||
      derivation.parallelization !== SCRYPT_PARALLELIZATION
    ) {
      throw new Error("The password challenge is invalid.");
    }
  } else if (
    !Number.isInteger(derivation.iterations) ||
    derivation.iterations < 100_000 ||
    derivation.iterations > 2_000_000
  ) {
    throw new Error("The password challenge is invalid.");
  }
  return salt;
}

export async function derivePasswordProof(
  password: string,
  derivation: PasswordDerivation,
) {
  const salt = assertDerivation(derivation);
  let derived: Uint8Array;
  if (derivation.algorithm === "scrypt") {
    derived = await scrypt(
      encoder.encode(password),
      salt,
      derivation.cost,
      derivation.blockSize,
      derivation.parallelization,
      derivation.keyLength,
    );
  } else {
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt,
        iterations: derivation.iterations,
      },
      material,
      derivation.keyLength * 8,
    );
    derived = new Uint8Array(bits);
  }
  return bytesToBase64Url(derived);
}
