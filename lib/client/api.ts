import {
  MAX_REQUEST_BYTES,
  apiErrorResponseSchema,
  reviewApiResponseSchema,
  rewriteApiResponseSchema,
  rewriteRequestSchema,
  type EditorialInput,
  type QuotationIssue,
  type ReviewResult,
  type RewriteHistoryEntryInput,
  type RewriteRefinementInput,
  type RewriteRequest,
  type SourceSnapshot,
} from "@/lib/shared/contracts";

export const REWRITE_REQUEST_SAFE_BYTES = MAX_REQUEST_BYTES - 8_192;

function jsonByteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function compactRewriteRequest(payload: RewriteRequest): RewriteRequest {
  if (jsonByteLength(payload) <= REWRITE_REQUEST_SAFE_BYTES || payload.history.length < 2) {
    return payload;
  }

  const history = payload.history.map((entry) => ({ ...entry }));
  // History is chronological. Remove only older version bodies, oldest first;
  // every instruction/preference and the newest current version remain intact.
  for (let index = 0; index < history.length - 1; index += 1) {
    if (jsonByteLength({ ...payload, history }) <= REWRITE_REQUEST_SAFE_BYTES) break;
    delete history[index].rewrittenText;
  }

  return { ...payload, history };
}

export class ApiRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: {
      messages?: string[];
      retryable?: boolean;
      stage?: "review_request" | "rewrite_request";
      provider?: string;
      model?: string;
      httpStatus?: number;
      causeSummary?: string;
      quotationIssues?: QuotationIssue[];
      candidateText?: string;
      attempts?: number;
    },
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function postJson(endpoint: string, body: unknown) {
  const stage = endpoint.endsWith("/rewrite") ? "rewrite_request" : "review_request";
  // One Review call can wait for DeepSeek's documented ten-minute queue window;
  // Rewrite can make two sequential provider calls for its validation retry.
  const timeoutMs = stage === "rewrite_request" ? 21 * 60_000 : 11 * 60_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      throw new ApiRequestError(
        "REQUEST_TIMEOUT",
        "The browser stopped waiting because the AI workflow exceeded its maximum duration.",
        {
          retryable: true,
          stage,
          provider: "DeepSeek",
          httpStatus: 0,
          causeSummary: `No complete application response arrived within ${Math.round(timeoutMs / 60_000)} minutes.`,
        },
      );
    }
    throw new ApiRequestError(
      "NETWORK_ERROR",
      "The server could not be reached. Check that the website is running and try again.",
      {
        retryable: true,
        stage,
        provider: "DeepSeek",
        httpStatus: 0,
        causeSummary: "The browser did not receive an HTTP response from the application server.",
      },
    );
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      throw new ApiRequestError(
        "REQUEST_TIMEOUT",
        "The browser stopped waiting because the AI workflow exceeded its maximum duration.",
        {
          retryable: true,
          stage,
          provider: "DeepSeek",
          httpStatus: 0,
          causeSummary: `No complete application response arrived within ${Math.round(timeoutMs / 60_000)} minutes.`,
        },
      );
    }
    throw new ApiRequestError("INVALID_SERVER_RESPONSE", "The server returned an unreadable response.");
  }
  clearTimeout(timeout);

  if (!response.ok) {
    const parsedError = apiErrorResponseSchema.safeParse(responseBody);
    if (parsedError.success) {
      const serverError = parsedError.data.error;
      throw new ApiRequestError(
        serverError.code,
        serverError.message,
        {
          messages: serverError.details,
          retryable: serverError.retryable,
          stage: serverError.stage,
          provider: serverError.provider,
          model: serverError.model,
          httpStatus: serverError.httpStatus ?? response.status,
          causeSummary: serverError.causeSummary,
          quotationIssues: serverError.quotationIssues,
          candidateText: serverError.candidateText,
          attempts: serverError.attempts,
        },
      );
    }
    throw new ApiRequestError("REQUEST_FAILED", "The request failed. Please try again.");
  }

  return responseBody;
}

export async function requestReview(input: EditorialInput | string) {
  const body: EditorialInput =
    typeof input === "string"
      ? { draft: input, sourceUrl: "" }
      : input;
  const responseBody = await postJson("/api/review", body);
  const parsed = reviewApiResponseSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new ApiRequestError(
      "INVALID_SERVER_RESPONSE",
      "The server returned an incomplete review. Please try again.",
    );
  }
  return parsed.data;
}

export async function requestRewrite(
  source: SourceSnapshot,
  review: ReviewResult,
  history: readonly RewriteHistoryEntryInput[] = [],
  refinement: RewriteRefinementInput = {},
) {
  const payload = compactRewriteRequest(
    rewriteRequestSchema.parse({ source, review, history, refinement }),
  );
  const responseBody = await postJson("/api/rewrite", payload);
  const parsed = rewriteApiResponseSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new ApiRequestError(
      "INVALID_SERVER_RESPONSE",
      "The server returned an incomplete rewrite. Please try again.",
    );
  }
  return parsed.data;
}
