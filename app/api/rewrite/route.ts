import { rewriteWithFeedback } from "@/lib/server/agents/workflow";
import { requireApiSession } from "@/lib/server/auth/guards";
import { recordAgentRequestAttempt } from "@/lib/server/auth/request-usage";
import { errorResponse, jsonResponse, readJsonRequest } from "@/lib/server/http";
import { rewriteRequestSchema, type RewriteApiResponse } from "@/lib/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request, ["client", "employee"], { csrf: true });
    const input = rewriteRequestSchema.parse(await readJsonRequest(request));
    await recordAgentRequestAttempt(session.user.id, "rewrite");
    const result: RewriteApiResponse = await rewriteWithFeedback(
      input.source,
      input.review,
      undefined,
      { history: input.history, refinement: input.refinement },
      input.model,
    );
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}
