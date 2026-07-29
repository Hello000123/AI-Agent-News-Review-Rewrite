import { z } from "zod";

import { getServerConfig, type ServerConfig } from "@/lib/server/config";
import { AppError } from "@/lib/server/errors";
import type { SelectableModelId } from "@/lib/shared/models";

const PROVIDER = "xAI";

const completionResponseSchema = z
  .object({
    choices: z
      .array(
        z.object({
          finish_reason: z.string().nullable(),
          message: z
            .object({
              content: z.string().nullable(),
              // Ignore any provider-specific reasoning field if one is returned.
              reasoning_content: z.string().nullable().optional(),
            })
            .passthrough(),
        }),
      )
      .min(1),
  })
  .passthrough();

const streamChunkSchema = z
  .object({
    choices: z.array(
      z
        .object({
          finish_reason: z.string().nullable().optional(),
          delta: z
            .object({
              content: z.string().nullable().optional(),
              // Ignore any provider-specific reasoning field if one is returned.
              reasoning_content: z.string().nullable().optional(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type CompletionStage = "review_request" | "rewrite_request";

export interface CompletionRequest {
  stage: CompletionStage;
  model?: SelectableModelId;
  systemPrompt: string;
  userPrompt: string;
  responseFormat: "json" | "text";
  maxTokens: number;
  // Retained for custom completion runners. The Grok request intentionally
  // omits sampling controls while using high reasoning effort.
  temperature?: number;
}

export interface GrokDependencies {
  config?: ServerConfig;
  fetchImpl?: typeof fetch;
}

interface CompletionParts {
  content: string;
  finishReason: string | null;
}

function safeModelIdentifier(model: string) {
  return /^[a-zA-Z0-9._:/-]{1,120}$/u.test(model) ? model : "[invalid model identifier]";
}

function effectiveModel(request: Pick<CompletionRequest, "model">, config: ServerConfig) {
  return request.model ?? config.model;
}

function diagnosticDetails(
  request: Pick<CompletionRequest, "stage" | "model">,
  config: ServerConfig,
  httpStatus: number,
  causeSummary: string,
  retryable: boolean,
) {
  return {
    stage: request.stage,
    provider: PROVIDER,
    model: safeModelIdentifier(effectiveModel(request, config)),
    httpStatus,
    causeSummary,
    retryable,
  } as const;
}

export function grokPublicDiagnostics(
  stage: CompletionStage,
  httpStatus: number,
  causeSummary: string,
  retryable: boolean,
  model?: SelectableModelId,
) {
  return diagnosticDetails({ stage, model }, getServerConfig(), httpStatus, causeSummary, retryable);
}

function providerCause(
  status: number,
  rawBody: string,
  request: CompletionRequest,
  config: ServerConfig,
) {
  const safeModel = safeModelIdentifier(effectiveModel(request, config));
  let providerMessage = "";
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: { message?: unknown; code?: unknown };
      message?: unknown;
    };
    const candidate = parsed.error?.message ?? parsed.message;
    const code = parsed.error?.code;
    if (typeof candidate === "string") providerMessage = candidate.toLowerCase();
    if (typeof code === "string") providerMessage += ` ${code.toLowerCase()}`;
  } catch {
    // Non-JSON upstream bodies are never copied into a public error.
  }

  if (status === 401) return "xAI rejected the API credentials.";
  if (status === 403) return "xAI denied access for the API key or team.";
  if (status === 402) return "The xAI account has insufficient balance.";
  if (status === 408) return "xAI timed out before accepting the request.";
  if (status === 429) return "The xAI account or model rate limit was reached.";
  if (
    (status === 400 || status === 404 || status === 422) &&
    (providerMessage.includes("model_not_found") ||
      providerMessage.includes("model not found") ||
      providerMessage.includes("model does not exist") ||
      (status === 404 && providerMessage.includes("model")))
  ) {
    return `xAI could not find selected model ${safeModel}. Verify that this API key can access ${safeModel}.`;
  }
  if (status === 404) {
    return "xAI could not find the configured model or API endpoint.";
  }
  if (status === 400 || status === 422) {
    return "xAI rejected one or more request parameters.";
  }
  if (status >= 500) return "xAI reported a temporary service or inference failure.";
  return `xAI returned HTTP ${status} without a usable completion.`;
}

function upstreamError(
  status: number,
  rawBody: string,
  request: CompletionRequest,
  config: ServerConfig,
) {
  const causeSummary = providerCause(status, rawBody, request, config);
  const publicDetails = diagnosticDetails(
    request,
    config,
    status,
    causeSummary,
    status === 408 || status === 429 || status >= 500,
  );

  if (status === 401 || status === 403) {
    return new AppError(
      "XAI_AUTH_ERROR",
      "xAI rejected the API credentials or permissions. Check XAI_API_KEY and its model access.",
      502,
      { publicDetails },
    );
  }
  if (status === 402) {
    return new AppError(
      "XAI_BALANCE_ERROR",
      "The xAI account has insufficient balance. Add credit and try again.",
      502,
      { publicDetails },
    );
  }
  if (status === 429) {
    return new AppError(
      "XAI_RATE_LIMIT",
      "xAI is receiving too many requests. Wait briefly and try again.",
      503,
      { publicDetails },
    );
  }
  if (status === 400 || status === 404 || status === 422) {
    const invalidModel = causeSummary.includes("Verify that this API key can access");
    return new AppError(
      invalidModel ? "XAI_MODEL_ERROR" : "XAI_REQUEST_REJECTED",
      invalidModel
        ? "xAI could not access the selected Grok model. Check the model and API-key permissions."
        : "xAI rejected the configured model, endpoint, or request parameters. Check the server configuration.",
      502,
      { publicDetails },
    );
  }
  return new AppError(
    "XAI_UNAVAILABLE",
    "xAI is temporarily unavailable. Please try again.",
    503,
    { publicDetails },
  );
}

function timeoutError(request: CompletionRequest, config: ServerConfig, cause?: unknown) {
  return new AppError(
    "XAI_TIMEOUT",
    "The AI request is taking longer than the configured maximum. Please retry later or use a shorter draft.",
    504,
    {
      cause,
      publicDetails: diagnosticDetails(
        request,
        config,
        0,
        `No complete xAI response arrived within ${Math.round(config.timeoutMs / 1_000)} seconds.`,
        true,
      ),
    },
  );
}

function malformedResponseError(
  request: CompletionRequest,
  config: ServerConfig,
  causeSummary: string,
  cause?: unknown,
) {
  return new AppError(
    "MALFORMED_AI_RESPONSE",
    "xAI returned an incomplete or unreadable response. Please try again.",
    502,
    {
      cause,
      publicDetails: diagnosticDetails(request, config, 200, causeSummary, true),
    },
  );
}

function finalizeCompletion(
  parts: CompletionParts,
  request: CompletionRequest,
  config: ServerConfig,
) {
  if (parts.finishReason !== "stop") {
    const causeSummary =
      parts.finishReason === "length"
        ? "Grok exhausted the output-token budget or context window before producing a complete final answer."
        : parts.finishReason === "insufficient_system_resource"
          ? "Grok interrupted generation because inference capacity was unavailable."
          : `Grok ended generation with finish reason ${parts.finishReason ?? "missing"}.`;
    throw new AppError(
      "INCOMPLETE_AI_RESPONSE",
      parts.finishReason === "length"
        ? "Grok's response was cut off. Please try a shorter draft."
        : "Grok did not complete the response. Please try again.",
      502,
      {
        publicDetails: diagnosticDetails(request, config, 200, causeSummary, true),
      },
    );
  }

  const content = parts.content.trim();
  if (!content) {
    throw new AppError(
      "EMPTY_AI_RESPONSE",
      "Grok completed the request but returned no final answer. Please try again.",
      502,
      {
        publicDetails: diagnosticDetails(
          request,
          config,
          200,
          "Grok returned HTTP 200 but message.content was empty. Private reasoning was not used as the final answer.",
          true,
        ),
      },
    );
  }

  return content;
}

async function parseNonStreamingResponse(
  response: Response,
  request: CompletionRequest,
  config: ServerConfig,
) {
  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch (error) {
    throw malformedResponseError(
      request,
      config,
      "The xAI HTTP 200 response body ended before a complete JSON document could be read.",
      error,
    );
  }

  let responseBody: unknown;
  try {
    responseBody = JSON.parse(rawBody);
  } catch (error) {
    throw malformedResponseError(
      request,
      config,
      rawBody.trim()
        ? "xAI returned HTTP 200 with a body that was not valid JSON."
        : "xAI returned HTTP 200 with an empty response body.",
      error,
    );
  }

  const parsed = completionResponseSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw malformedResponseError(
      request,
      config,
      "xAI returned HTTP 200 with an unexpected non-streaming response schema.",
    );
  }

  const choice = parsed.data.choices[0];
  return { content: choice.message.content ?? "", finishReason: choice.finish_reason };
}

async function parseStreamingResponse(
  response: Response,
  request: CompletionRequest,
  config: ServerConfig,
) {
  if (!response.body) {
    throw malformedResponseError(
      request,
      config,
      "xAI returned an event-stream response without a readable body.",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  let sawDone = false;

  function processEvent(eventText: string) {
    const data = eventText
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) return;
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch (error) {
      throw malformedResponseError(
        request,
        config,
        "xAI sent an invalid JSON event in the streaming response.",
        error,
      );
    }
    const parsed = streamChunkSchema.safeParse(payload);
    if (!parsed.success) {
      throw malformedResponseError(
        request,
        config,
        "xAI sent an unexpected event schema in the streaming response.",
      );
    }

    for (const choice of parsed.data.choices) {
      // reasoning_content is deliberately ignored and never concatenated, logged, or returned.
      if (choice.delta.content) content += choice.delta.content;
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/u);
      buffer = events.pop() ?? "";
      for (const event of events) processEvent(event);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processEvent(buffer);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw malformedResponseError(
      request,
      config,
      "The xAI streaming response ended before a complete final event was received.",
      error,
    );
  } finally {
    reader.releaseLock();
  }

  if (!sawDone && !finishReason) {
    throw malformedResponseError(
      request,
      config,
      "The xAI stream ended without a completion marker or finish reason.",
    );
  }
  return { content, finishReason };
}

export async function requestGrokCompletion(
  request: CompletionRequest,
  dependencies: GrokDependencies = {},
) {
  const config = dependencies.config ?? getServerConfig();
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  if (!config.apiKey) {
    throw new AppError(
      "XAI_NOT_CONFIGURED",
      "The server is not configured with an xAI API key. Add XAI_API_KEY and restart it.",
      503,
      {
        publicDetails: diagnosticDetails(
          request,
          config,
          0,
          "The server has no xAI API key configured.",
          false,
        ),
      },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const body: Record<string, unknown> = {
    model: effectiveModel(request, config),
    messages: [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt },
    ],
    reasoning_effort: "high",
    max_tokens: request.maxTokens,
    stream: config.streamResponses,
  };

  if (config.streamResponses) {
    body.stream_options = { include_usage: true };
  }
  if (request.responseFormat === "json") {
    body.response_format = { type: "json_object" };
  }

  let response: Response;
  try {
    response = await fetchImpl(config.apiBaseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (controller.signal.aborted) throw timeoutError(request, config, error);
    throw new AppError(
      "XAI_NETWORK_ERROR",
      "The server could not reach xAI. Check the network connection and try again.",
      502,
      {
        cause: error,
        publicDetails: diagnosticDetails(
          request,
          config,
          0,
          "The connection failed before xAI returned an HTTP response.",
          true,
        ),
      },
    );
  }

  try {
    if (!response.ok) {
      let rawErrorBody = "";
      try {
        rawErrorBody = await response.text();
      } catch {
        // Status-based diagnostics remain useful if the error body is interrupted.
      }
      throw upstreamError(response.status, rawErrorBody, request, config);
    }

    const isEventStream = response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream");
    const parts = isEventStream
      ? await parseStreamingResponse(response, request, config)
      : await parseNonStreamingResponse(response, request, config);
    return finalizeCompletion(parts, request, config);
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError(request, config, error);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
