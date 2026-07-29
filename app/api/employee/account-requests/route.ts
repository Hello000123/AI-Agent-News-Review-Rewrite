import { getDatabase } from "@/lib/server/auth/database";
import { requireApiSession } from "@/lib/server/auth/guards";
import { authErrorResponse } from "@/lib/server/auth/http";
import { listAccountRequests } from "@/lib/server/auth/repository";
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
    const requests = await listAccountRequests(getDatabase(), status);
    return jsonResponse({ requests });
  } catch (error) {
    return authErrorResponse(error);
  }
}
