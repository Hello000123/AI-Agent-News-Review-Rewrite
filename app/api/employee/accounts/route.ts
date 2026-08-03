import { getDatabase } from "@/lib/server/auth/database";
import { requireApiSession } from "@/lib/server/auth/guards";
import { authErrorResponse } from "@/lib/server/auth/http";
import {
  getAccountRoleSummary,
  listUserAccounts,
} from "@/lib/server/auth/repository";
import { AppError } from "@/lib/server/errors";
import { jsonResponse } from "@/lib/server/http";
import { USER_ROLES, type UserRole } from "@/lib/shared/auth-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireApiSession(request, ["employee"]);
    const rawRole = new URL(request.url).searchParams.get("role");
    if (!rawRole || !USER_ROLES.includes(rawRole as UserRole)) {
      throw new AppError(
        "INVALID_ACCOUNT_ROLE",
        "Choose either client or employee accounts.",
        400,
      );
    }

    const role = rawRole as UserRole;
    const database = getDatabase();
    const [accounts, summary] = await Promise.all([
      listUserAccounts(database, role),
      getAccountRoleSummary(database),
    ]);
    return jsonResponse({ accounts, summary });
  } catch (error) {
    return authErrorResponse(error, {
      operation: "employee.accounts.list",
      request,
    });
  }
}
