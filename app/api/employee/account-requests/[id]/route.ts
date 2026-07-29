import {
  approveAccountRequest,
  rejectAccountRequest,
} from "@/lib/server/auth/account-service";
import { getPublicAppUrlForRequest } from "@/lib/server/auth/config";
import { getDatabase } from "@/lib/server/auth/database";
import { requireApiSession } from "@/lib/server/auth/guards";
import { authErrorResponse } from "@/lib/server/auth/http";
import { getAccountRequestById } from "@/lib/server/auth/repository";
import { jsonResponse, readJsonRequest } from "@/lib/server/http";
import { accountDecisionInputSchema } from "@/lib/shared/auth-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    await requireApiSession(request, ["employee"]);
    const { id } = await context.params;
    const accountRequest = await getAccountRequestById(getDatabase(), id);
    if (!accountRequest) {
      return jsonResponse(
        { error: { code: "ACCOUNT_REQUEST_NOT_FOUND", message: "Account request not found." } },
        404,
      );
    }
    return jsonResponse({ request: accountRequest });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const session = await requireApiSession(request, ["employee"], { csrf: true });
    const input = accountDecisionInputSchema.parse(await readJsonRequest(request));
    const { id } = await context.params;
    const result =
      input.action === "approve"
        ? await approveAccountRequest(
            getDatabase(),
            id,
            session.user,
            getPublicAppUrlForRequest(request),
          )
        : await rejectAccountRequest(
            getDatabase(),
            id,
            session.user,
            input.rejectionReason,
          );
    return jsonResponse({
      request: result.request,
      emailDelivery: {
        status: result.delivery.status,
        ...(result.delivery.developmentSetupUrl
          ? { developmentSetupUrl: result.delivery.developmentSetupUrl }
          : {}),
      },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
