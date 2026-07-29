import { ZodError } from "zod";

import { AppError, isAppError } from "@/lib/server/errors";
import { jsonResponse } from "@/lib/server/http";
import { getPublicAppUrl } from "@/lib/server/auth/config";
import type { AuthApiErrorBody, UserRole } from "@/lib/shared/auth-contracts";

function validationFieldErrors(error: ZodError) {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    fieldErrors[field] ??= [];
    if (!fieldErrors[field].includes(issue.message)) fieldErrors[field].push(issue.message);
  }
  return fieldErrors;
}

export function authErrorResponse(error: unknown) {
  if (error instanceof ZodError) {
    const body: AuthApiErrorBody = {
      error: {
        code: "VALIDATION_ERROR",
        message: "Check the highlighted fields and try again.",
        fieldErrors: validationFieldErrors(error),
      },
    };
    return jsonResponse(body, 400);
  }

  if (isAppError(error)) {
    const body: AuthApiErrorBody = {
      error: {
        code: error.code,
        message: error.publicMessage,
      },
    };
    return jsonResponse(body, error.status);
  }

  const body: AuthApiErrorBody = {
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred. Please try again.",
    },
  };
  return jsonResponse(body, 500);
}

export function validateSameOrigin(request: Request) {
  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin) {
    throw new AppError("CSRF_REJECTED", "This request could not be verified.", 403);
  }

  try {
    const origin = new URL(rawOrigin).origin;
    const requestOrigin = new URL(request.url).origin;
    if (origin === requestOrigin || origin === getPublicAppUrl()) return;
  } catch (error) {
    if (isAppError(error)) throw error;
  }

  throw new AppError("CSRF_REJECTED", "This request could not be verified.", 403);
}

export function getClientIp(request: Request) {
  const direct = request.headers.get("cf-connecting-ip")?.trim();
  if (direct) return direct.slice(0, 64);
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || "unknown").slice(0, 64);
}

export function safeReturnPath(
  candidate: string | undefined,
  role: UserRole,
) {
  if (!candidate?.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
    return role === "employee" ? "/employee" : "/";
  }
  try {
    const parsed = new URL(candidate, "https://local.invalid");
    if (parsed.origin !== "https://local.invalid") {
      return role === "employee" ? "/employee" : "/";
    }
    if (role !== "employee" && parsed.pathname.startsWith("/employee")) return "/";
    if (
      ["/login", "/request-account", "/request-submitted", "/setup-password"].includes(
        parsed.pathname,
      )
    ) {
      return role === "employee" ? "/employee" : "/";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return role === "employee" ? "/employee" : "/";
  }
}
