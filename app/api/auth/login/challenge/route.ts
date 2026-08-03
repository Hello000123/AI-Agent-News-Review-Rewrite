import { NextResponse } from "next/server";

import { getDatabase } from "@/lib/server/auth/database";
import {
  authErrorResponse,
  validateSameOrigin,
} from "@/lib/server/auth/http";
import { prepareLoginPasswordChallenge } from "@/lib/server/auth/login-service";
import { readJsonRequest } from "@/lib/server/http";
import { loginChallengeInputSchema } from "@/lib/shared/auth-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    validateSameOrigin(request);
    const input = loginChallengeInputSchema.parse(
      await readJsonRequest(request),
    );
    const derivation = await prepareLoginPasswordChallenge(
      getDatabase(),
      input.email,
    );
    return NextResponse.json(
      { derivation },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    return authErrorResponse(error, {
      operation: "auth.login.challenge",
      request,
    });
  }
}
