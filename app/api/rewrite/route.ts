import { rewriteWithFeedback } from "@/lib/server/agents/workflow";
import { errorResponse, jsonResponse, readJsonRequest } from "@/lib/server/http";
import { rewriteRequestSchema, type RewriteApiResponse } from "@/lib/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const input = rewriteRequestSchema.parse(await readJsonRequest(request));
    const finalText = await rewriteWithFeedback(input.draft, input.review);
    const result: RewriteApiResponse = { finalText };
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}
