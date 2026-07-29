import { redirect } from "next/navigation";

import { getDatabase } from "@/lib/server/auth/database";
import { validateSameOrigin } from "@/lib/server/auth/http";
import {
  getPageSession,
  getRequestSession,
  validateSessionCsrf,
} from "@/lib/server/auth/sessions";
import { AppError } from "@/lib/server/errors";
import type { UserRole } from "@/lib/shared/auth-contracts";

const ALL_ROLES: readonly UserRole[] = ["client", "employee"];

export async function requireApiSession(
  request: Request,
  allowedRoles: readonly UserRole[] = ALL_ROLES,
  options: { csrf?: boolean } = {},
) {
  const session = await getRequestSession(getDatabase(), request);
  if (!session) {
    throw new AppError(
      "AUTH_REQUIRED",
      "Sign in to continue.",
      401,
    );
  }
  if (!allowedRoles.includes(session.user.role)) {
    throw new AppError(
      "FORBIDDEN",
      "You do not have permission to access this resource.",
      403,
    );
  }
  if (options.csrf) {
    validateSameOrigin(request);
    if (!(await validateSessionCsrf(request, session))) {
      throw new AppError("CSRF_REJECTED", "This request could not be verified.", 403);
    }
  }
  return session;
}

export async function getOptionalPageSession() {
  return getPageSession(getDatabase());
}

export async function requirePageSession(
  pathname: string,
  allowedRoles: readonly UserRole[] = ALL_ROLES,
) {
  const session = await getOptionalPageSession();
  if (!session) {
    redirect(`/login?returnTo=${encodeURIComponent(pathname)}`);
  }
  if (!allowedRoles.includes(session.user.role)) {
    redirect("/access-denied");
  }
  return session;
}
