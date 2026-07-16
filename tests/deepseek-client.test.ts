import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestDeepSeekCompletion,
  type CompletionRequest,
} from "@/lib/server/agents/deepseek-client";
import type { ServerConfig } from "@/lib/server/config";

const config: ServerConfig = {
  apiKey: "test-secret-key",
  apiBaseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  passScore: 80,
  timeoutMs: 10_000,
  streamResponses: true,
};

const reviewRequest: CompletionRequest = {
  stage: "review_request",
  systemPrompt: "Return valid JSON.",
  userPrompt: "Review this draft.",
  responseFormat: "json",
  maxTokens: 64_000,
  temperature: 0.2,
};

function completionResponse(
  content: string | null,
  finishReason = "stop",
  reasoningContent = "PRIVATE_REASONING_MARKER",
) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: finishReason,
          message: { content, reasoning_content: reasoningContent },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function streamingResponse() {
  const events = [
    ": keep-alive\n\n",
    `data: ${JSON.stringify({
      choices: [
        {
          delta: { reasoning_content: "PRIVATE_REASONING_MARKER" },
          finish_reason: null,
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: { content: '{"overall' }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: { content: 'Score":80}' }, finish_reason: "stop" }],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 20 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const bytes = new TextEncoder().encode(events);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Split within an SSE JSON object to verify fragmented event handling.
      controller.enqueue(bytes.slice(0, 73));
      controller.enqueue(bytes.slice(73, 191));
      controller.enqueue(bytes.slice(191));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

describe("DeepSeek client", () => {
  afterEach(() => vi.useRealTimers());

  it("sends the verified V4 Pro maximum-thinking streaming request without leaking the key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamingResponse());

    const content = await requestDeepSeekCompletion(reviewRequest, {
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(content).toBe('{"overallScore":80}');
    expect(content).not.toContain("PRIVATE_REASONING_MARKER");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-secret-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "deepseek-v4-pro",
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      max_tokens: 64_000,
      response_format: { type: "json_object" },
    });
    expect(body).not.toHaveProperty("temperature");
    expect(String(init.body)).not.toContain("test-secret-key");
  });

  it("supports the official non-streaming schema and uses only final content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completionResponse("Final answer."));
    const content = await requestDeepSeekCompletion(
      { ...reviewRequest, responseFormat: "text", stage: "rewrite_request" },
      {
        config: { ...config, streamResponses: false },
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
    );

    expect(content).toBe("Final answer.");
    expect(content).not.toContain("PRIVATE_REASONING_MARKER");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ stream: false });
    expect(body).not.toHaveProperty("stream_options");
    expect(body).not.toHaveProperty("response_format");
  });

  it("fails before making a request when the API key is absent", async () => {
    const fetchMock = vi.fn();
    await expect(
      requestDeepSeekCompletion(reviewRequest, {
        config: { ...config, apiKey: "" },
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "DEEPSEEK_NOT_CONFIGURED",
      status: 503,
      publicDetails: {
        stage: "review_request",
        provider: "DeepSeek",
        model: "deepseek-v4-pro",
        httpStatus: 0,
        retryable: false,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("captures a safe invalid-model cause and upstream HTTP status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message:
              "The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed invalid-model-diagnostic.",
            type: "invalid_request_error",
            code: "invalid_request_error",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    let failure: unknown;
    try {
      await requestDeepSeekCompletion(reviewRequest, {
        config: { ...config, model: "invalid-model-diagnostic" },
        fetchImpl: fetchMock as unknown as typeof fetch,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "DEEPSEEK_MODEL_ERROR",
      status: 502,
      publicDetails: {
        stage: "review_request",
        provider: "DeepSeek",
        model: "invalid-model-diagnostic",
        httpStatus: 400,
        retryable: false,
        causeSummary: expect.stringContaining("Supported model IDs"),
      },
    });
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain("test-secret-key");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("PRIVATE_REASONING_MARKER");
  });

  it("maps authentication and rate-limit failures to safe diagnostics", async () => {
    for (const [status, code, retryable] of [
      [401, "DEEPSEEK_AUTH_ERROR", false],
      [429, "DEEPSEEK_RATE_LIMIT", true],
    ] as const) {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "untrusted provider detail" } }), {
          status,
        }),
      );
      await expect(
        requestDeepSeekCompletion(reviewRequest, {
          config,
          fetchImpl: fetchMock as unknown as typeof fetch,
        }),
      ).rejects.toMatchObject({
        code,
        publicDetails: { httpStatus: status, retryable },
        publicMessage: expect.not.stringContaining("untrusted provider detail"),
      });
    }
  });

  it("aborts and reports a timeout with workflow diagnostics", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const requestPromise = requestDeepSeekCompletion(reviewRequest, {
      config: { ...config, timeoutMs: 25 },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const expectation = expect(requestPromise).rejects.toMatchObject({
      code: "DEEPSEEK_TIMEOUT",
      status: 504,
      publicDetails: { stage: "review_request", httpStatus: 0, retryable: true },
    });

    await vi.advanceTimersByTimeAsync(26);
    await expectation;
  });

  it("rejects malformed, empty, truncated, and incomplete streaming responses", async () => {
    const malformedFetch = vi.fn().mockResolvedValue(
      new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    await expect(
      requestDeepSeekCompletion(reviewRequest, {
        config,
        fetchImpl: malformedFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "MALFORMED_AI_RESPONSE",
      publicDetails: { httpStatus: 200 },
    });

    const emptyFetch = vi.fn().mockResolvedValue(completionResponse("   "));
    await expect(
      requestDeepSeekCompletion(reviewRequest, {
        config,
        fetchImpl: emptyFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "EMPTY_AI_RESPONSE" });

    const truncatedFetch = vi.fn().mockResolvedValue(completionResponse('{"partial":', "length"));
    await expect(
      requestDeepSeekCompletion(reviewRequest, {
        config,
        fetchImpl: truncatedFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "INCOMPLETE_AI_RESPONSE" });

    const incompleteStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              choices: [{ delta: { reasoning_content: "PRIVATE_REASONING_MARKER" } }],
            })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    const incompleteFetch = vi.fn().mockResolvedValue(
      new Response(incompleteStream, { headers: { "Content-Type": "text/event-stream" } }),
    );
    await expect(
      requestDeepSeekCompletion(reviewRequest, {
        config,
        fetchImpl: incompleteFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "MALFORMED_AI_RESPONSE" });
  });
});
