import { AppError } from "@/lib/server/errors";

export type AppEnvironment = "development" | "test" | "production";
export type EmailDeliveryMode = "preview" | "http";

function integerSetting(
  rawValue: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (!rawValue?.trim()) return fallback;
  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function getAppEnvironment(): AppEnvironment {
  const configured = process.env.APP_ENV?.trim().toLowerCase();
  if (configured === "production" || configured === "test" || configured === "development") {
    return configured;
  }
  return process.env.NODE_ENV === "production"
    ? "production"
    : process.env.NODE_ENV === "test"
      ? "test"
      : "development";
}

export function isProductionEnvironment() {
  return getAppEnvironment() === "production";
}

export function getSessionTtlSeconds() {
  return integerSetting(process.env.SESSION_TTL_SECONDS, 12 * 60 * 60, 15 * 60, 7 * 24 * 60 * 60);
}

export function getPasswordSetupTtlSeconds() {
  return integerSetting(
    process.env.PASSWORD_SETUP_TTL_SECONDS,
    24 * 60 * 60,
    60 * 60,
    7 * 24 * 60 * 60,
  );
}

export function getAuthSecret() {
  const secret = process.env.AUTH_SECRET?.trim();
  if (secret && secret.length >= 32) return secret;
  if (!isProductionEnvironment()) {
    return "development-only-auth-secret-change-before-production";
  }
  throw new AppError(
    "AUTH_NOT_CONFIGURED",
    "Authentication is temporarily unavailable.",
    503,
  );
}

export function getPublicAppUrl() {
  const candidate = process.env.PUBLIC_APP_URL?.trim() || "http://localhost:3000";
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Unsupported public application URL.");
    }
    if (isProductionEnvironment() && url.protocol !== "https:") {
      throw new Error("Production application URLs must use HTTPS.");
    }
    return url.origin;
  } catch {
    throw new AppError(
      "AUTH_NOT_CONFIGURED",
      "Authentication is temporarily unavailable.",
      503,
    );
  }
}

export function getPublicAppUrlForRequest(request: Request) {
  if (!isProductionEnvironment()) return new URL(request.url).origin;
  return getPublicAppUrl();
}

export function getEmailDeliveryMode(): EmailDeliveryMode {
  const configured = process.env.EMAIL_DELIVERY_MODE?.trim().toLowerCase();
  if (configured === "http") return "http";
  if (configured === "preview" && !isProductionEnvironment()) return "preview";
  if (!configured && !isProductionEnvironment()) return "preview";
  throw new AppError(
    "EMAIL_NOT_CONFIGURED",
    "Email delivery is not configured.",
    503,
  );
}

export function getEmailProviderConfig() {
  const endpoint = process.env.EMAIL_PROVIDER_API_URL?.trim();
  const apiKey = process.env.EMAIL_PROVIDER_API_KEY?.trim();
  const senderAddress = process.env.EMAIL_FROM_ADDRESS?.trim();
  const senderName = process.env.EMAIL_FROM_NAME?.trim() || "PressReady";
  const authHeader = process.env.EMAIL_PROVIDER_AUTH_HEADER?.trim() || "Authorization";
  const authScheme = process.env.EMAIL_PROVIDER_AUTH_SCHEME?.trim() ?? "Bearer";

  if (!endpoint || !apiKey || !senderAddress) {
    throw new AppError("EMAIL_NOT_CONFIGURED", "Email delivery is not configured.", 503);
  }

  try {
    const endpointUrl = new URL(endpoint);
    if (
      !["http:", "https:"].includes(endpointUrl.protocol) ||
      endpointUrl.username ||
      endpointUrl.password ||
      (isProductionEnvironment() && endpointUrl.protocol !== "https:")
    ) {
      throw new Error("Invalid email provider URL.");
    }
  } catch {
    throw new AppError("EMAIL_NOT_CONFIGURED", "Email delivery is not configured.", 503);
  }

  return {
    endpoint,
    apiKey,
    senderAddress,
    senderName,
    authHeader,
    authScheme,
  };
}

export function getApprovalNotificationEmail() {
  const email = process.env.ACCOUNT_APPROVAL_NOTIFICATION_EMAIL?.trim().toLowerCase();
  if (email) return email;
  if (!isProductionEnvironment()) return "employee@example.test";
  throw new AppError(
    "EMAIL_NOT_CONFIGURED",
    "Account request notifications are not configured.",
    503,
  );
}
