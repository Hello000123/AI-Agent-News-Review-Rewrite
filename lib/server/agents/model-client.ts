import {
  deepSeekPublicDiagnostics,
  requestDeepSeekCompletion,
} from "@/lib/server/agents/deepseek-client";
import {
  grokPublicDiagnostics,
  requestGrokCompletion,
  type CompletionRequest,
  type CompletionStage,
} from "@/lib/server/agents/grok-client";
import { AppError } from "@/lib/server/errors";
import {
  DEFAULT_SELECTABLE_MODEL,
  isSelectableModelId,
  type SelectableModelId,
} from "@/lib/shared/models";

export type { CompletionRequest, CompletionStage };

function selectedModel(model?: SelectableModelId) {
  return model ?? DEFAULT_SELECTABLE_MODEL;
}

export function modelPublicDiagnostics(
  stage: CompletionStage,
  httpStatus: number,
  causeSummary: string,
  retryable: boolean,
  model?: SelectableModelId,
) {
  return selectedModel(model) === "deepseek-v4-pro"
    ? deepSeekPublicDiagnostics(stage, httpStatus, causeSummary, retryable)
    : grokPublicDiagnostics(stage, httpStatus, causeSummary, retryable, "grok-4.5");
}

export async function requestModelCompletion(request: CompletionRequest) {
  const model = selectedModel(request.model);
  if (!isSelectableModelId(model)) {
    throw new AppError(
      "UNSUPPORTED_MODEL",
      "Unsupported AI model. Choose DeepSeek V4 Pro or Grok 4.5.",
      400,
      {
        publicDetails: {
          stage: request.stage,
          model: String(model),
          retryable: false,
        },
      },
    );
  }

  if (model === "deepseek-v4-pro") {
    return requestDeepSeekCompletion({ ...request, model });
  }
  return requestGrokCompletion({ ...request, model: "grok-4.5" });
}
