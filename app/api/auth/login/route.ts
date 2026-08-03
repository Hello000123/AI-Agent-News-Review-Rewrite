import { NextResponse } from "next/server";

import { getDatabase } from "@/lib/server/auth/database";
import {
  authErrorResponse,
  safeReturnPath,
  validateSameOrigin,
} from "@/lib/server/auth/http";
import { loginWithPasswordProof } from "@/lib/server/auth/login-service";
import { setSessionCookies } from "@/lib/server/auth/sessions";
import { loginProofInputSchema } from "@/lib/shared/auth-contracts";
import { readJsonRequest } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    validateSameOrigin(request);
    const input = loginProofInputSchema.parse(await readJsonRequest(request));
    const result = await loginWithPasswordProof(
      getDatabase(),
      input.email,
      input.passwordProof,
      request,
    );
    const response = NextResponse.json(
      {
        user: result.user,
        redirectTo: safeReturnPath(input.returnTo, result.user.role),
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
    return authErrorResponse(error, { operation: "auth.login", request });
  }
}
