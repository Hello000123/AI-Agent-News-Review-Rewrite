import { reviewDraft } from "@/lib/server/agents/workflow";
import { requireApiSession } from "@/lib/server/auth/guards";
import { recordAgentRequestAttempt } from "@/lib/server/auth/request-usage";
import { errorResponse, jsonResponse, readJsonRequest } from "@/lib/server/http";
import { reviewRequestSchema, type ReviewApiResponse } from "@/lib/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request, ["client", "employee"], { csrf: true });
    const input = reviewRequestSchema.parse(await readJsonRequest(request));
    await recordAgentRequestAttempt(session.user.id, "review");
    const result: ReviewApiResponse = await reviewDraft(input);
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}
