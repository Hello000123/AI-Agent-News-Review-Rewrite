import { prepareSourceSnapshot, rewriteWithFeedback } from "@/lib/server/agents/workflow";
import { requireApiSession } from "@/lib/server/auth/guards";
import { recordAgentRequestAttempt } from "@/lib/server/auth/request-usage";
import { errorResponse, jsonResponse, readJsonRequest } from "@/lib/server/http";
import {
  editorialInputSchema,
  type DirectRewriteApiResponse,
} from "@/lib/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request, ["client", "employee"], { csrf: true });
    const input = editorialInputSchema.parse(await readJsonRequest(request));
    await recordAgentRequestAttempt(session.user.id, "rewrite");

    const source = await prepareSourceSnapshot(input);
    const rewrite = await rewriteWithFeedback(
      source,
      null,
      undefined,
      undefined,
      input.model,
    );
    const result: DirectRewriteApiResponse = { ...rewrite, source };
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}
