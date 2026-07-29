import { accountRequestInputSchema } from "@/lib/shared/auth-contracts";
import { submitAccountRequest } from "@/lib/server/auth/account-service";
import { getPublicAppUrlForRequest } from "@/lib/server/auth/config";
import { getDatabase } from "@/lib/server/auth/database";
import { authErrorResponse, validateSameOrigin } from "@/lib/server/auth/http";
import { jsonResponse, readJsonRequest } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    validateSameOrigin(request);
    const input = accountRequestInputSchema.parse(await readJsonRequest(request));
    const result = await submitAccountRequest(
      getDatabase(),
      input,
      getPublicAppUrlForRequest(request),
    );
    return jsonResponse(
      {
        requestId: result.request.id,
        status: result.request.status,
        message:
          "Your account request has been submitted and is awaiting employee approval.",
        notificationStatus: result.delivery.status,
      },
      201,
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
