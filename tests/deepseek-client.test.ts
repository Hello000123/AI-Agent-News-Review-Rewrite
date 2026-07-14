import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestDeepSeekCompletion,
  type CompletionRequest,
} from "@/lib/server/agents/deepseek-client";
import type { ServerConfig } from "@/lib/server/config";

const config: ServerConfig = {
  apiKey: "test-secret-key",
  apiBaseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  passScore: 80,
  timeoutMs: 10_000,
};

const reviewRequest: CompletionRequest = {
  systemPrompt: "Return valid JSON.",
  userPrompt: "Review this draft.",
  responseFormat: "json",
  maxTokens: 2_000,
  temperature: 0.2,
};

function completionResponse(content: string | null, finishReason = "stop") {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: finishReason, message: { content } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("DeepSeek client", () => {
  afterEach(() => vi.useRealTimers());

  it("sends the key only in the server-side authorization header and enables JSON mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completionResponse('{"overallScore":80}'));

    await requestDeepSeekCompletion(reviewRequest, {
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-secret-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      stream: false,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
    });
    expect(String(init.body)).not.toContain("test-secret-key");
  });

  it("omits JSON mode for Rewrite Agent text output", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completionResponse("Rewritten news report."));
    await requestDeepSeekCompletion(
      { ...reviewRequest, responseFormat: "text" },
      { config, fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("response_format");
  });

  it("fails before making a request when the API key is absent", async () => {
    const fetchMock = vi.fn();
    await expect(
      requestDeepSeekCompletion(reviewRequest, {
        config: { ...config, apiKey: "" },
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "DEEPSEEK_NOT_CONFIGURED", status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps authentication failures to a clear safe error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      requestDeepSeekCompletion(reviewRequest, {
        config,
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "DEEPSEEK_AUTH_ERROR", status: 502 });
  });

  it("maps rate limiting without exposing provider response content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "sensitive provider detail" } }), {
        status: 429,
      }),
    );
    await expect(
      requestDeepSeekCompletion(reviewRequest, {
        config,
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "DEEPSEEK_RATE_LIMIT",
      publicMessage: expect.not.stringContaining("sensitive provider detail"),
    });
  });

  it("aborts and reports a timeout", async () => {
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
    });

    await vi.advanceTimersByTimeAsync(26);
    await expectation;
  });

  it("rejects malformed, empty, or truncated provider responses", async () => {
    const malformedFetch = vi.fn().mockResolvedValue(
      new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    await expect(
      requestDeepSeekCompletion(reviewRequest, {
        config,
        fetchImpl: malformedFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "MALFORMED_AI_RESPONSE" });

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
  });
});
