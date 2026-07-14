export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
export const DEFAULT_REVIEW_PASS_SCORE = 80;
export const DEFAULT_TIMEOUT_MS = 90_000;

export interface ServerConfig {
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  passScore: number;
  timeoutMs: number;
}

function integerInRange(rawValue: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (!rawValue?.trim()) return fallback;

  const value = Number(rawValue);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

export function getReviewPassScore() {
  return integerInRange(process.env.REVIEW_PASS_SCORE, DEFAULT_REVIEW_PASS_SCORE, 0, 100);
}

function normalizeBaseUrl(rawValue: string | undefined) {
  const candidate = rawValue?.trim() || DEFAULT_DEEPSEEK_BASE_URL;
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return DEFAULT_DEEPSEEK_BASE_URL;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_DEEPSEEK_BASE_URL;
  }
}

export function getServerConfig(): ServerConfig {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY?.trim() || "",
    apiBaseUrl: normalizeBaseUrl(process.env.DEEPSEEK_API_BASE_URL),
    model: process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
    passScore: getReviewPassScore(),
    timeoutMs: integerInRange(process.env.DEEPSEEK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 600_000),
  };
}
