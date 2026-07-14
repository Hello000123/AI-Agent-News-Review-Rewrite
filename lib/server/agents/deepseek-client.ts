import { z } from "zod";

import { getServerConfig, type ServerConfig } from "@/lib/server/config";
import { AppError } from "@/lib/server/errors";

const completionResponseSchema = z
  .object({
    choices: z
      .array(
        z.object({
          finish_reason: z.string().nullable(),
          message: z.object({ content: z.string().nullable() }).passthrough(),
        }),
      )
      .min(1),
  })
  .passthrough();

export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  responseFormat: "json" | "text";
  maxTokens: number;
  temperature?: number;
}

export interface DeepSeekDependencies {
  config?: ServerConfig;
  fetchImpl?: typeof fetch;
}

function upstreamError(status: number) {
  if (status === 401 || status === 403) {
    return new AppError(
      "DEEPSEEK_AUTH_ERROR",
      "DeepSeek rejected the API credentials. Check DEEPSEEK_API_KEY and try again.",
      502,
    );
  }
  if (status === 402) {
    return new AppError(
      "DEEPSEEK_BALANCE_ERROR",
      "The DeepSeek account has insufficient balance. Add credit and try again.",
      502,
    );
  }
  if (status === 429) {
    return new AppError(
      "DEEPSEEK_RATE_LIMIT",
      "DeepSeek is receiving too many requests. Wait briefly and try again.",
      503,
    );
  }
  if (status === 400 || status === 422) {
    return new AppError(
      "DEEPSEEK_REQUEST_REJECTED",
      "DeepSeek could not process this request. Check the configured model and try again.",
      502,
    );
  }
  return new AppError(
    "DEEPSEEK_UNAVAILABLE",
    "DeepSeek is temporarily unavailable. Please try again.",
    503,
  );
}

export async function requestDeepSeekCompletion(
  request: CompletionRequest,
  dependencies: DeepSeekDependencies = {},
) {
  const config = dependencies.config ?? getServerConfig();
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  if (!config.apiKey) {
    throw new AppError(
      "DEEPSEEK_NOT_CONFIGURED",
      "The server is not configured with a DeepSeek API key. Add DEEPSEEK_API_KEY and restart it.",
      503,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt },
    ],
    thinking: { type: "disabled" },
    temperature: request.temperature ?? 0.2,
    max_tokens: request.maxTokens,
    stream: false,
  };

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
    if (controller.signal.aborted) {
      throw new AppError(
        "DEEPSEEK_TIMEOUT",
        "The AI request took too long. Please try again with a shorter draft or retry later.",
        504,
        { cause: error },
      );
    }
    throw new AppError(
      "DEEPSEEK_NETWORK_ERROR",
      "The server could not reach DeepSeek. Check the network connection and try again.",
      502,
      { cause: error },
    );
  }

  if (!response.ok) {
    clearTimeout(timeout);
    throw upstreamError(response.status);
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError(
        "DEEPSEEK_TIMEOUT",
        "The AI request took too long. Please try again with a shorter draft or retry later.",
        504,
        { cause: error },
      );
    }
    throw new AppError(
      "MALFORMED_AI_RESPONSE",
      "DeepSeek returned an unreadable response. Please try again.",
      502,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  const parsed = completionResponseSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new AppError(
      "MALFORMED_AI_RESPONSE",
      "DeepSeek returned an unexpected response. Please try again.",
      502,
    );
  }

  const choice = parsed.data.choices[0];
  if (choice.finish_reason !== "stop") {
    const message =
      choice.finish_reason === "length"
        ? "DeepSeek's response was cut off. Please try a shorter draft."
        : "DeepSeek did not complete the response. Please try again.";
    throw new AppError("INCOMPLETE_AI_RESPONSE", message, 502);
  }

  const content = choice.message.content?.trim();
  if (!content) {
    throw new AppError(
      "EMPTY_AI_RESPONSE",
      "DeepSeek returned an empty response. Please try again.",
      502,
    );
  }

  return content;
}
