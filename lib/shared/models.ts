export const SELECTABLE_MODEL_IDS = ["deepseek-v4-pro", "grok-4.5"] as const;

export type SelectableModelId = (typeof SELECTABLE_MODEL_IDS)[number];

export const DEFAULT_SELECTABLE_MODEL: SelectableModelId = "grok-4.5";

export const SELECTABLE_MODELS = [
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "DeepSeek's flagship reasoning model for detailed editorial analysis.",
    recommended: false,
  },
  {
    id: "grok-4.5",
    label: "Grok 4.5",
    description: "Latest flagship for the strongest review and rewrite quality.",
    recommended: true,
  },
] as const satisfies readonly {
  id: SelectableModelId;
  label: string;
  description: string;
  recommended: boolean;
}[];

export function isSelectableModelId(value: string): value is SelectableModelId {
  return SELECTABLE_MODEL_IDS.some((modelId) => modelId === value);
}

export function selectableModelById(modelId: SelectableModelId) {
  return SELECTABLE_MODELS.find((model) => model.id === modelId)
    ?? SELECTABLE_MODELS.find((model) => model.id === DEFAULT_SELECTABLE_MODEL)
    ?? SELECTABLE_MODELS[0];
}
