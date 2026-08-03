import { inspectPasswordSetupToken } from "@/lib/server/auth/account-service";
import { getDatabase } from "@/lib/server/auth/database";
import { authErrorResponse, validateSameOrigin } from "@/lib/server/auth/http";
import { AppError } from "@/lib/server/errors";
import { jsonResponse, readJsonRequest } from "@/lib/server/http";
import { setupTokenInputSchema } from "@/lib/shared/auth-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    validateSameOrigin(request);
    const input = setupTokenInputSchema.parse(await readJsonRequest(request));
    const token = await inspectPasswordSetupToken(getDatabase(), input.token);
    if (!token) {
      throw new AppError(
        "INVALID_SETUP_TOKEN",
        "This password setup link is invalid, expired, or has already been used.",
        400,
      );
    }
    return jsonResponse(token);
  } catch (error) {
    return authErrorResponse(error, {
      operation: "auth.password-setup.validate",
      request,
    });
  }
}
