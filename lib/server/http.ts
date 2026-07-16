import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { AppError, isAppError } from "@/lib/server/errors";
import { MAX_REQUEST_BYTES, type ApiErrorResponse } from "@/lib/shared/contracts";

const responseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

async function readLimitedBody(request: Request) {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let body = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new AppError("REQUEST_TOO_LARGE", "The request is too large.", 413);
    }
    body += decoder.decode(value, { stream: true });
  }

  return body + decoder.decode();
}

export async function readJsonRequest(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Requests must use application/json.", 415);
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new AppError("REQUEST_TOO_LARGE", "The request is too large.", 413);
  }

  const rawBody = await readLimitedBody(request);

  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw new AppError("INVALID_JSON", "The request body contains invalid JSON.", 400, {
      cause: error,
    });
  }
}

export function jsonResponse<T>(body: T, status = 200) {
  return NextResponse.json(body, { status, headers: responseHeaders });
}

export function errorResponse(error: unknown) {
  if (error instanceof ZodError) {
    const body: ApiErrorResponse = {
      error: {
        code: "VALIDATION_ERROR",
        message: "Check the submitted draft and try again.",
        details: error.issues.map((issue) => issue.message),
      },
    };
    return jsonResponse(body, 400);
  }

  if (isAppError(error)) {
    const body: ApiErrorResponse = {
      error: {
        code: error.code,
        message: error.publicMessage,
        ...error.publicDetails,
      },
    };
    return jsonResponse(body, error.status);
  }

  const body: ApiErrorResponse = {
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected server error occurred. Please try again.",
    },
  };
  return jsonResponse(body, 500);
}
