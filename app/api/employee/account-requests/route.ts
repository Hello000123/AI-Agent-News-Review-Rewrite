import { getDatabase } from "@/lib/server/auth/database";
import { requireApiSession } from "@/lib/server/auth/guards";
import { authErrorResponse } from "@/lib/server/auth/http";
import {
  getAccountRoleSummary,
  listAccountRequests,
} from "@/lib/server/auth/repository";
import { jsonResponse } from "@/lib/server/http";
import { ACCOUNT_REQUEST_STATUSES } from "@/lib/shared/auth-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireApiSession(request, ["employee"]);
    const rawStatus = new URL(request.url).searchParams.get("status");
    const status =
      rawStatus && ACCOUNT_REQUEST_STATUSES.includes(
        rawStatus as (typeof ACCOUNT_REQUEST_STATUSES)[number],
      )
        ? (rawStatus as (typeof ACCOUNT_REQUEST_STATUSES)[number])
        : undefined;
    const database = getDatabase();
    const [requests, summary] = await Promise.all([
      listAccountRequests(database, status),
      getAccountRoleSummary(database),
    ]);
    return jsonResponse({ requests, summary });
  } catch (error) {
    return authErrorResponse(error, {
      operation: "employee.account-requests.list",
      request,
    });
  }
}
