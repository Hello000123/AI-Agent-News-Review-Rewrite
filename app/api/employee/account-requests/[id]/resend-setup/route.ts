import { resendPasswordSetupEmail } from "@/lib/server/auth/account-service";
import { getPublicAppUrlForRequest } from "@/lib/server/auth/config";
import { getDatabase } from "@/lib/server/auth/database";
import { requireApiSession } from "@/lib/server/auth/guards";
import { authErrorResponse } from "@/lib/server/auth/http";
import { jsonResponse } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const session = await requireApiSession(request, ["employee"], { csrf: true });
    const { id } = await context.params;
    const result = await resendPasswordSetupEmail(
      getDatabase(),
      id,
      session.user,
      getPublicAppUrlForRequest(request),
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
