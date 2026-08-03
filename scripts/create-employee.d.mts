import type { Readable, Writable } from "node:stream";

export const PASSWORD_MIN_LENGTH: number;
export const PASSWORD_MAX_LENGTH: number;

export function normalizeEmail(value: string): string;
export function normalizeFullName(value: string): string;
export function passwordProblems(password: string): string[];
export function parseTargetOptions(
  args: string[],
  configuredDatabase?: string,
): {
  help: boolean;
  target: "local" | "remote";
  databaseName: string;
};
export function hashPassword(password: string): Promise<string>;
export function promptForAccount(
  input: Readable,
  output: Writable,
): Promise<{
  email: string;
  fullName: string;
  password: string;
}>;
export function main(options?: {
  args?: string[];
  input?: Readable;
  output?: Writable;
}): Promise<void>;
