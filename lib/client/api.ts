import {
  apiErrorResponseSchema,
  reviewApiResponseSchema,
  rewriteApiResponseSchema,
  type ReviewResult,
} from "@/lib/shared/contracts";

export class ApiRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function postJson(endpoint: string, body: unknown) {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(
      "NETWORK_ERROR",
      "The server could not be reached. Check that the website is running and try again.",
    );
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new ApiRequestError("INVALID_SERVER_RESPONSE", "The server returned an unreadable response.");
  }

  if (!response.ok) {
    const parsedError = apiErrorResponseSchema.safeParse(responseBody);
    if (parsedError.success) {
      const details = parsedError.data.error.details?.join(" ");
      throw new ApiRequestError(
        parsedError.data.error.code,
        details || parsedError.data.error.message,
      );
    }
    throw new ApiRequestError("REQUEST_FAILED", "The request failed. Please try again.");
  }

  return responseBody;
}

export async function requestReview(draft: string) {
  const responseBody = await postJson("/api/review", { draft });
  const parsed = reviewApiResponseSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new ApiRequestError(
      "INVALID_SERVER_RESPONSE",
      "The server returned an incomplete review. Please try again.",
    );
  }
  return parsed.data;
}

export async function requestRewrite(draft: string, review: ReviewResult) {
  const responseBody = await postJson("/api/rewrite", { draft, review });
  const parsed = rewriteApiResponseSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new ApiRequestError(
      "INVALID_SERVER_RESPONSE",
      "The server returned an incomplete rewrite. Please try again.",
    );
  }
  return parsed.data;
}
