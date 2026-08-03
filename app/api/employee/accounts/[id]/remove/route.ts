import { removeClientAccount } from "@/lib/server/auth/account-service";
import { getDatabase } from "@/lib/server/auth/database";
import { requireApiSession } from "@/lib/server/auth/guards";
import { authErrorResponse } from "@/lib/server/auth/http";
import { jsonResponse, readJsonRequest } from "@/lib/server/http";
import { clientRemovalInputSchema } from "@/lib/shared/auth-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const session = await requireApiSession(request, ["employee"], { csrf: true });
    const input = clientRemovalInputSchema.parse(await readJsonRequest(request));
    const { id } = await context.params;
    const result = await removeClientAccount(
      getDatabase(),
      id,
      session.user,
      input.message,
    );
    return jsonResponse({
      removedAccount: result.client,
      audit: result.audit,
      emailDelivery: { status: result.delivery.status },
    });
  } catch (error) {
    return authErrorResponse(error, {
      operation: "employee.client-account.remove",
      request,
    });
  }
}
