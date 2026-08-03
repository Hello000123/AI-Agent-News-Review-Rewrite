import { NextResponse } from "next/server";

import { completePasswordSetup } from "@/lib/server/auth/account-service";
import { getDatabase } from "@/lib/server/auth/database";
import { authErrorResponse, validateSameOrigin } from "@/lib/server/auth/http";
import { setSessionCookies } from "@/lib/server/auth/sessions";
import { readJsonRequest } from "@/lib/server/http";
import { passwordSetupInputSchema } from "@/lib/shared/auth-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    validateSameOrigin(request);
    const input = passwordSetupInputSchema.parse(await readJsonRequest(request));
    const result = await completePasswordSetup(
      getDatabase(),
      input.token,
      input.passwordSalt,
      input.passwordProof,
      request,
    );
    const response = NextResponse.json(
      {
        user: result.user,
        redirectTo: "/",
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
    setSessionCookies(response, result.session, request);
    return response;
  } catch (error) {
    return authErrorResponse(error, { operation: "auth.password-setup", request });
  }
}
