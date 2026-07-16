import { runReviewAgent, type CompletionRunner } from "@/lib/server/agents/review-agent";
import { runRewriteAgent } from "@/lib/server/agents/rewrite-agent";
import { getServerConfig } from "@/lib/server/config";
import { AppError } from "@/lib/server/errors";
import {
  buildSourceContext,
  SourceContextError,
  type SourceContextDependencies,
} from "@/lib/server/sources/source-context";
import {
  editorialInputSchema,
  MAX_DRAFT_CHARS,
  MAX_IMAGE_CONTEXT_ITEMS,
  MAX_REFERENCE_CHARS,
  sourceSnapshotSchema,
  type EditorialInput,
  type OutputLanguage,
  type ReviewApiResponse,
  type ReviewResult,
  type SourceSnapshot,
} from "@/lib/shared/contracts";

interface ReviewWorkflowDependencies {
  completionRunner?: CompletionRunner;
  passScore?: number;
  sourceContextDependencies?: SourceContextDependencies;
}

function sourceErrorStatus(code: SourceContextError["code"]) {
  if (code === "SOURCE_FETCH_TIMEOUT") return 504;
  if (code === "SOURCE_TOO_LARGE") return 413;
  if (code === "UNSUPPORTED_SOURCE_TYPE") return 415;
  if (code === "INVALID_SOURCE_URL" || code === "NON_PUBLIC_SOURCE") return 400;
  return 502;
}

function mapSourceError(error: SourceContextError) {
  const retryable = ![
    "INVALID_SOURCE_URL",
    "NON_PUBLIC_SOURCE",
    "SOURCE_TOO_LARGE",
    "UNSUPPORTED_SOURCE_TYPE",
  ].includes(error.code);
  return new AppError(error.code, error.message, sourceErrorStatus(error.code), {
    cause: error,
    publicDetails: { retryable },
  });
}

function withLinkImageContext(
  inputItems: EditorialInput["imageContext"],
  linkedImageText: string,
) {
  const items = inputItems.map((item) => ({ ...item }));
  if (!linkedImageText.trim()) return items;

  const sourceItem = {
    label: "Retrieved source-page image context",
    text: linkedImageText.trim().slice(0, 4_000),
    source: "link_caption" as const,
  };
  if (items.length < MAX_IMAGE_CONTEXT_ITEMS) return [...items, sourceItem];

  const last = items.at(-1);
  if (!last) return [sourceItem];
  items[items.length - 1] = {
    ...last,
    label: `${last.label} + source-page captions`.slice(0, 200),
    text: `${last.text}\n\n[Source-page captions]\n${sourceItem.text}`.slice(0, 4_000),
  };
  return items;
}

export async function prepareSourceSnapshot(
  editorialInput: EditorialInput,
  sourceDependencies: SourceContextDependencies = {},
): Promise<SourceSnapshot> {
  const input = editorialInputSchema.parse(editorialInput);
  const userDraft = input.draft.trim();

  let linked = {
    url: "",
    title: "",
    articleText: "",
    imageContext: "",
  };
  if (input.sourceUrl.trim()) {
    try {
      const context = await buildSourceContext(
        { draftText: userDraft, sourceUrl: input.sourceUrl },
        {
          ...sourceDependencies,
          limits: {
            ...sourceDependencies.limits,
            maxDraftChars: sourceDependencies.limits?.maxDraftChars ?? MAX_DRAFT_CHARS,
            maxArticleChars:
              sourceDependencies.limits?.maxArticleChars ?? MAX_REFERENCE_CHARS,
            maxCombinedChars:
              sourceDependencies.limits?.maxCombinedChars ??
              MAX_DRAFT_CHARS + MAX_REFERENCE_CHARS,
          },
        },
      );
      linked = context;
    } catch (error) {
      if (error instanceof SourceContextError) throw mapSourceError(error);
      throw error;
    }
  }

  const imageContext = withLinkImageContext(input.imageContext, linked.imageContext);
  const imagePrimaryText = imageContext
    .map(({ label, text }) => `[${label}]\n${text}`)
    .join("\n\n");
  const retrievedArticle = [linked.title.trim(), linked.articleText.trim()]
    .filter(Boolean)
    .join("\n\n");
  const primaryText = userDraft || retrievedArticle || imagePrimaryText;
  if (!primaryText) {
    throw new AppError(
      "EMPTY_SOURCE_CONTENT",
      "The source did not contain usable article text. Paste the article or add verified image text and try again.",
      422,
      { publicDetails: { retryable: false } },
    );
  }

  return sourceSnapshotSchema.parse({
    primaryText,
    userDraft,
    sourceUrl: linked.url || undefined,
    linkedTitle: linked.title || undefined,
    linkedText: userDraft && linked.articleText.trim() ? linked.articleText : undefined,
    imageContext,
  });
}

export async function reviewDraft(
  input: EditorialInput | string,
  dependencies: ReviewWorkflowDependencies = {},
): Promise<ReviewApiResponse> {
  const editorialInput =
    typeof input === "string"
      ? editorialInputSchema.parse({
          draft: input,
          sourceUrl: "",
          imageContext: [],
          outputLanguage: "original",
        })
      : editorialInputSchema.parse(input);
  const passScore = dependencies.passScore ?? getServerConfig().passScore;
  const source = await prepareSourceSnapshot(
    editorialInput,
    dependencies.sourceContextDependencies,
  );
  const review = await runReviewAgent(source, passScore, dependencies.completionRunner);

  return {
    review,
    source,
    passScore,
    message:
      review.overallScore >= passScore
        ? "This copy meets the quality threshold. Review the calibrated feedback, then rewrite whenever you choose."
        : "This copy is below the quality threshold. Review the calibrated feedback, then request a rewrite.",
  };
}

export async function rewriteWithFeedback(
  source: SourceSnapshot,
  review: ReviewResult,
  outputLanguage: OutputLanguage = "original",
  completionRunner?: CompletionRunner,
) {
  return runRewriteAgent(source, review, outputLanguage, completionRunner);
}
