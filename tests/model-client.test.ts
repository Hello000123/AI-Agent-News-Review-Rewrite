import { describe, expect, it, vi } from "vitest";

import {
  requestModelCompletion,
  type CompletionRequest,
} from "@/lib/server/agents/model-client";

const baseRequest: CompletionRequest = {
  stage: "review_request",
  systemPrompt: "Return valid JSON.",
  userPrompt: "Review this draft.",
  responseFormat: "json",
  maxTokens: 1_000,
};

describe("model provider router", () => {
  it("rejects removed or arbitrary model identifiers before any provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const model of ["grok-4.3", "arbitrary-provider-model"]) {
      await expect(
        requestModelCompletion({
          ...baseRequest,
          model: model as CompletionRequest["model"],
        }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_MODEL",
        status: 400,
        publicMessage: "Unsupported AI model. Choose DeepSeek V4 Pro or Grok 4.5.",
        publicDetails: {
          stage: "review_request",
          model,
          retryable: false,
        },
      });
    }

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
