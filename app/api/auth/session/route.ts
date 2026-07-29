import { requireApiSession } from "@/lib/server/auth/guards";
import { authErrorResponse } from "@/lib/server/auth/http";
import { jsonResponse } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireApiSession(request);
    return jsonResponse({
      user: session.user,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
