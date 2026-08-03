import { NextResponse } from "next/server";

import { getDatabase } from "@/lib/server/auth/database";
import { requireApiSession } from "@/lib/server/auth/guards";
import { authErrorResponse } from "@/lib/server/auth/http";
import {
  clearSessionCookies,
  revokeRequestSession,
} from "@/lib/server/auth/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await requireApiSession(request, ["client", "employee"], { csrf: true });
    await revokeRequestSession(getDatabase(), request);
    const response = NextResponse.json(
      { redirectTo: "/login" },
      {
        headers: {
          "Cache-Control": "no-store",
          "Clear-Site-Data": '"cache", "storage"',
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
    clearSessionCookies(response, request);
    return response;
  } catch (error) {
    const response = authErrorResponse(error, { operation: "auth.logout", request });
    if (response.status === 401) clearSessionCookies(response, request);
    return response;
  }
}
