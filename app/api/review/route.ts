import { reviewDraft } from "@/lib/server/agents/workflow";
import { errorResponse, jsonResponse, readJsonRequest } from "@/lib/server/http";
import { reviewRequestSchema, type ReviewApiResponse } from "@/lib/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const input = reviewRequestSchema.parse(await readJsonRequest(request));
    const result: ReviewApiResponse = await reviewDraft(input.draft);
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}
