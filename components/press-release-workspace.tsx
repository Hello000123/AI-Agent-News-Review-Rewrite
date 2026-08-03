"use client";

import { useEffect, useRef, useState } from "react";

import { OutputPanel } from "@/components/output-panel";
import { QuotationFailurePanel } from "@/components/quotation-failure-panel";
import { ReviewSummary } from "@/components/review-summary";
import {
  ApiRequestError,
  requestDirectRewrite,
  requestReview,
  requestRewrite,
} from "@/lib/client/api";
import { AuthRequestError } from "@/lib/client/auth-api";
import { requestFileExtraction } from "@/lib/client/file-api";
import {
  clearRewriteSession,
  loadRewriteSession,
  saveRewriteSession,
  type CompletedRewriteTurn,
} from "@/lib/client/rewrite-session";
import {
  MAX_DRAFT_CHARS,
  MAX_REWRITE_HISTORY_ENTRIES,
  type EditorialInput,
  type QuotationIssue,
  type ReviewResult,
  type RewriteRefinement,
  type SourceSnapshot,
} from "@/lib/shared/contracts";
import {
  FILE_UPLOAD_ACCEPT,
  SUPPORTED_UPLOAD_HELP,
  validateUploadMetadata,
} from "@/lib/shared/file-upload";
import {
  DEFAULT_SELECTABLE_MODEL,
  SELECTABLE_MODELS,
  selectableModelById,
  type SelectableModelId,
} from "@/lib/shared/models";

type ProcessingState = "idle" | "reviewing" | "rewriting";

type DraftAttachmentState = {
  name: string;
  type: string;
  size: number;
  status: "processing" | "awaiting-choice" | "added" | "error";
  error?: string;
  truncated?: boolean;
};

type RewriteState =
  | { status: "idle" }
  | { status: "loading"; attemptId: number }
  | {
      status: "success";
      attemptId: number;
      text: string;
      validation: { status: "passed" | "passed_after_retry"; attempts: 1 | 2 };
    }
  | {
      status: "quotation-failed";
      attemptId: number;
      issues: QuotationIssue[];
      candidateText?: string;
      attempts?: number;
    };

interface VisibleError {
  message: string;
  retryable: boolean;
  context: "review" | "rewrite" | "copy";
  diagnostics?: ApiRequestError["details"];
}

interface PressReleaseWorkspaceProps {
  initialPassScore: number;
  initialModel?: SelectableModelId;
}

const EMPTY_REWRITE_REFINEMENT: RewriteRefinement = {
  lengthOption: null,
  instruction: "",
};

function countWords(text: string) {
  const normalized = text.trim();
  return normalized ? normalized.split(/\s+/u).length : 0;
}

function messageForError(error: unknown) {
  if (error instanceof ApiRequestError) {
    const details = error.code === "VALIDATION_ERROR"
      ? error.details?.messages?.join(" ")
      : "";
    return details || error.message;
  }
  return "Something went wrong while processing the draft. Please try again.";
}

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m ${String(remainder).padStart(2, "0")}s` : `${seconds}s`;
}

function stageLabel(stage: NonNullable<ApiRequestError["details"]>["stage"]) {
  return stage === "review_request" ? "Review Agent request" : "Rewrite Agent request";
}

function inputSignature(input: EditorialInput) {
  return JSON.stringify({
    draft: input.draft,
    sourceUrl: input.sourceUrl,
    model: input.model ?? DEFAULT_SELECTABLE_MODEL,
  });
}

export function PressReleaseWorkspace({
  initialPassScore,
  initialModel = DEFAULT_SELECTABLE_MODEL,
}: PressReleaseWorkspaceProps) {
  const [draft, setDraft] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [selectedModel, setSelectedModel] = useState<SelectableModelId>(initialModel);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [reviewedInputSignature, setReviewedInputSignature] = useState("");
  const [reviewedSource, setReviewedSource] = useState<SourceSnapshot | null>(null);
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [rewriteState, setRewriteState] = useState<RewriteState>({ status: "idle" });
  const [rewriteHistory, setRewriteHistory] = useState<CompletedRewriteTurn[]>([]);
  const [message, setMessage] = useState("");
  const [passScore, setPassScore] = useState(initialPassScore);
  const [processing, setProcessing] = useState<ProcessingState>("idle");
  const [inputError, setInputError] = useState("");
  const [requestError, setRequestError] = useState<VisibleError | null>(null);
  const [copied, setCopied] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [sessionHydrated, setSessionHydrated] = useState(false);
  const [draftAttachment, setDraftAttachment] =
    useState<DraftAttachmentState | null>(null);
  const [pendingExtractedText, setPendingExtractedText] = useState("");
  const [uploadDragActive, setUploadDragActive] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const inFlightRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const activeRequestRef = useRef(0);
  const lastRefinementRef = useRef<RewriteRefinement>(EMPTY_REWRITE_REFINEMENT);
  const uploadSequenceRef = useRef(0);
  const busy = processing !== "idle";
  const words = countWords(draft);
  const selectedModelDetails = selectableModelById(selectedModel);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (processing === "idle") return;

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [processing]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const stored = loadRewriteSession();
      if (stored) {
        const restoredInput = {
          draft: stored.draft,
          sourceUrl: stored.sourceUrl,
          model: stored.model,
        };
        const restoredSignature = inputSignature(restoredInput);
        const legacySignature = JSON.stringify({
          draft: stored.draft,
          sourceUrl: stored.sourceUrl,
        });
        if (
          restoredSignature === stored.reviewedInputSignature ||
          legacySignature === stored.reviewedInputSignature
        ) {
          setDraft(stored.draft);
          setSourceUrl(stored.sourceUrl);
          setSelectedModel(stored.model);
          setReviewedInputSignature(restoredSignature);
          setReviewedSource(stored.reviewedSource);
          setReview(stored.review);
          setRewriteHistory(stored.history);
          setMessage(stored.message);
          setPassScore(stored.passScore);

          const currentTurn = stored.history.at(-1);
          if (currentTurn) {
            setRewriteState({
              status: "success",
              attemptId: 0,
              text: currentTurn.rewrittenText,
              validation: { status: "passed", attempts: 1 },
            });
          }
        } else {
          clearRewriteSession();
        }
      }
      setSessionHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (
      !sessionHydrated ||
      !reviewedSource ||
      !reviewedInputSignature ||
      inputSignature({ draft, sourceUrl, model: selectedModel }) !== reviewedInputSignature
    ) {
      return;
    }

    saveRewriteSession({
      version: 1,
      draft,
      sourceUrl,
      model: selectedModel,
      reviewedInputSignature,
      reviewedSource,
      review,
      message,
      passScore,
      history: rewriteHistory,
    });
  }, [
    draft,
    message,
    passScore,
    review,
    reviewedInputSignature,
    reviewedSource,
    rewriteHistory,
    selectedModel,
    sessionHydrated,
    sourceUrl,
  ]);

  function currentInput(): EditorialInput {
    return {
      draft,
      sourceUrl,
      model: selectedModel,
    };
  }

  const reviewIsStale = Boolean(
    review && inputSignature(currentInput()) !== reviewedInputSignature,
  );
  const finalText = rewriteState.status === "success" ? rewriteState.text : "";

  function clearResults() {
    setReviewedInputSignature("");
    setReviewedSource(null);
    setReview(null);
    setRewriteState({ status: "idle" });
    setRewriteHistory([]);
    setMessage("");
    setPassScore(initialPassScore);
    setCopied(false);
    setRequestError(null);
    lastRefinementRef.current = EMPTY_REWRITE_REFINEMENT;
    clearRewriteSession();
  }

  function focusInput() {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.scrollIntoView({ block: "center" });
    });
  }

  function showRequestError(error: VisibleError) {
    setRequestError(error);
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  function markSourceChanged() {
    setRequestError(null);
    setInputError("");
    setRewriteState({ status: "idle" });
    setRewriteHistory([]);
    setCopied(false);
    lastRefinementRef.current = EMPTY_REWRITE_REFINEMENT;
    clearRewriteSession();
  }

  function handleModelChange(model: SelectableModelId) {
    if (inFlightRef.current || model === selectedModel) return;
    setSelectedModel(model);
    markSourceChanged();
  }

  function removeDraftAttachment() {
    uploadSequenceRef.current += 1;
    setDraftAttachment(null);
    setPendingExtractedText("");
    setUploadDragActive(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function processDraftFile(file: File) {
    if (busy) return;
    const validation = validateUploadMetadata(file);
    if ("error" in validation) {
      setDraftAttachment({
        name: file.name || "Selected file",
        type: file.type || "Unknown type",
        size: file.size,
        status: "error",
        error: validation.error,
      });
      setPendingExtractedText("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    const requestId = ++uploadSequenceRef.current;
    setDraftAttachment({
      name: file.name,
      type: validation.formatLabel,
      size: file.size,
      status: "processing",
    });
    setPendingExtractedText("");
    setInputError("");
    try {
      const result = await requestFileExtraction(file);
      if (uploadSequenceRef.current !== requestId) return;
      const currentDraft = draftRef.current;
      const nextAttachment: DraftAttachmentState = {
        name: result.file.name,
        type: result.file.type,
        size: result.file.size,
        status: currentDraft.trim() ? "awaiting-choice" : "added",
        truncated: result.truncated,
      };
      setDraftAttachment(nextAttachment);
      if (currentDraft.trim()) {
        setPendingExtractedText(result.content);
      } else {
        draftRef.current = result.content;
        setDraft(result.content);
        markSourceChanged();
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    } catch (error) {
      if (uploadSequenceRef.current !== requestId) return;
      setDraftAttachment({
        name: file.name,
        type: validation.formatLabel,
        size: file.size,
        status: "error",
        error:
          error instanceof AuthRequestError
            ? error.message
            : "The file could not be processed. Try another file.",
      });
    }
  }

  function applyExtractedContent(mode: "append" | "replace") {
    if (!pendingExtractedText || !draftAttachment) return;
    const nextDraft =
      mode === "append"
        ? `${draft.trimEnd()}\n\n${pendingExtractedText}`
        : pendingExtractedText;
    if (nextDraft.length > MAX_DRAFT_CHARS) {
      setDraftAttachment({
        ...draftAttachment,
        status: "awaiting-choice",
        error:
          "Appending this file would exceed the 50,000-character draft limit. Replace the draft or shorten the existing text first.",
      });
      return;
    }
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setPendingExtractedText("");
    setDraftAttachment({ ...draftAttachment, status: "added", error: undefined });
    markSourceChanged();
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function validateInput(input: EditorialInput) {
    if (!input.draft.trim() && !input.sourceUrl.trim()) {
      return "Enter draft text or a source URL before requesting a review.";
    }
    if (input.draft.length > MAX_DRAFT_CHARS) {
      return "Drafts are limited to 50,000 characters.";
    }
    return "";
  }

  async function handleReview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current) return;

    const input = currentInput();
    const validationError = validateInput(input);
    if (validationError) {
      setInputError(validationError);
      inputRef.current?.focus();
      return;
    }

    const requestId = ++requestSequenceRef.current;
    activeRequestRef.current = requestId;
    inFlightRef.current = true;
    setInputError("");
    setRequestError(null);
    setCopied(false);
    setReview(null);
    setReviewedSource(null);
    setReviewedInputSignature("");
    setRewriteState({ status: "idle" });
    setRewriteHistory([]);
    lastRefinementRef.current = EMPTY_REWRITE_REFINEMENT;
    clearRewriteSession();
    setModelPickerOpen(false);
    setElapsedSeconds(0);
    setProcessing("reviewing");

    try {
      const result = await requestReview(input);
      if (activeRequestRef.current !== requestId) return;
      setReviewedInputSignature(inputSignature(input));
      setReviewedSource(result.source);
      setReview(result.review);
      setMessage(result.message);
      setPassScore(result.passScore);
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (error) {
      if (activeRequestRef.current !== requestId) return;
      showRequestError({
        message: messageForError(error),
        retryable: error instanceof ApiRequestError
          ? error.details?.retryable ?? error.code !== "VALIDATION_ERROR"
          : true,
        context: "review",
        diagnostics: error instanceof ApiRequestError ? error.details : undefined,
      });
    } finally {
      if (activeRequestRef.current === requestId) {
        inFlightRef.current = false;
        setProcessing("idle");
      }
    }
  }

  async function handleDirectRewrite() {
    if (inFlightRef.current) return;

    const input = currentInput();
    const validationError = validateInput(input);
    if (validationError) {
      setInputError(validationError);
      inputRef.current?.focus();
      return;
    }

    const requestId = ++requestSequenceRef.current;
    activeRequestRef.current = requestId;
    inFlightRef.current = true;
    setInputError("");
    setRequestError(null);
    setCopied(false);
    setReview(null);
    setReviewedSource(null);
    setReviewedInputSignature("");
    setRewriteState({ status: "loading", attemptId: requestId });
    setRewriteHistory([]);
    setMessage("");
    setPassScore(initialPassScore);
    lastRefinementRef.current = EMPTY_REWRITE_REFINEMENT;
    clearRewriteSession();
    setModelPickerOpen(false);
    setElapsedSeconds(0);
    setProcessing("rewriting");

    try {
      const result = await requestDirectRewrite(input);
      if (activeRequestRef.current !== requestId) return;
      const firstTurn: CompletedRewriteTurn = {
        rewrittenText: result.finalText,
        lengthOption: null,
        instruction: "",
      };
      setReviewedInputSignature(inputSignature(input));
      setReviewedSource(result.source);
      setRewriteHistory([firstTurn]);
      setRewriteState({
        status: "success",
        attemptId: requestId,
        text: result.finalText,
        validation: result.validation,
      });
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (error) {
      if (activeRequestRef.current !== requestId) return;
      if (
        error instanceof ApiRequestError &&
        error.code === "INEXACT_REWRITE_QUOTATION" &&
        error.details?.quotationIssues?.length
      ) {
        setRewriteState({
          status: "quotation-failed",
          attemptId: requestId,
          issues: error.details.quotationIssues,
          candidateText: error.details.candidateText,
          attempts: error.details.attempts,
        });
      } else {
        setRewriteState({ status: "idle" });
        showRequestError({
          message: messageForError(error),
          retryable: error instanceof ApiRequestError
            ? error.details?.retryable ?? error.code !== "VALIDATION_ERROR"
            : true,
          context: "rewrite",
          diagnostics: error instanceof ApiRequestError ? error.details : undefined,
        });
      }
    } finally {
      if (activeRequestRef.current === requestId) {
        inFlightRef.current = false;
        setProcessing("idle");
      }
    }
  }

  async function handleRewrite(refinement: RewriteRefinement) {
    if (inFlightRef.current || !reviewedSource || reviewIsStale) return;
    if (rewriteHistory.length >= MAX_REWRITE_HISTORY_ENTRIES) {
      showRequestError({
        message:
          `This article session has reached its ${MAX_REWRITE_HISTORY_ENTRIES}-rewrite context limit. Start a new draft to begin a fresh session.`,
        retryable: false,
        context: "rewrite",
      });
      return;
    }

    const submittedRefinement: RewriteRefinement = {
      lengthOption: refinement.lengthOption ?? null,
      instruction: refinement.instruction.trim(),
    };
    lastRefinementRef.current = submittedRefinement;

    const requestId = ++requestSequenceRef.current;
    activeRequestRef.current = requestId;
    inFlightRef.current = true;
    setRequestError(null);
    setCopied(false);
    setRewriteState({ status: "loading", attemptId: requestId });
    setElapsedSeconds(0);
    setProcessing("rewriting");

    try {
      const result = await requestRewrite(
        reviewedSource,
        review,
        rewriteHistory,
        submittedRefinement,
        selectedModel,
      );
      if (activeRequestRef.current !== requestId) return;
      setRewriteHistory((history) => [
        ...history,
        {
          rewrittenText: result.finalText,
          lengthOption: submittedRefinement.lengthOption,
          instruction: submittedRefinement.instruction,
        },
      ]);
      setRewriteState({
        status: "success",
        attemptId: requestId,
        text: result.finalText,
        validation: result.validation,
      });
      requestAnimationFrame(() => outputRef.current?.focus());
    } catch (error) {
      if (activeRequestRef.current !== requestId) return;
      if (
        error instanceof ApiRequestError &&
        error.code === "INEXACT_REWRITE_QUOTATION" &&
        error.details?.quotationIssues?.length
      ) {
        setRewriteState({
          status: "quotation-failed",
          attemptId: requestId,
          issues: error.details.quotationIssues,
          candidateText: error.details.candidateText,
          attempts: error.details.attempts,
        });
      } else {
        setRewriteState({ status: "idle" });
        showRequestError({
          message: messageForError(error),
          retryable: error instanceof ApiRequestError ? error.details?.retryable !== false : true,
          context: "rewrite",
          diagnostics: error instanceof ApiRequestError ? error.details : undefined,
        });
      }
    } finally {
      if (activeRequestRef.current === requestId) {
        inFlightRef.current = false;
        setProcessing("idle");
      }
    }
  }

  function handleInitialRewrite() {
    return handleRewrite(EMPTY_REWRITE_REFINEMENT);
  }

  function handleRetryRewrite() {
    if (!reviewedSource) return handleDirectRewrite();
    return handleRewrite(lastRefinementRef.current);
  }

  async function handleCopy() {
    if (!finalText) return;
    setRequestError(null);

    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(finalText);
      setCopied(true);
      return;
    } catch {
      const output = outputRef.current;
      if (output) {
        output.focus();
        output.select();
        output.setSelectionRange(0, output.value.length);
        if (document.execCommand("copy")) {
          setCopied(true);
          return;
        }
      }
      showRequestError({
        message: "The browser could not copy the output. Select the text and copy it manually.",
        retryable: false,
        context: "copy",
      });
    }
  }

  function handleStartNew() {
    removeDraftAttachment();
    draftRef.current = "";
    setDraft("");
    setSourceUrl("");
    setInputError("");
    clearResults();
    focusInput();
  }

  const loadingMessage = processing === "reviewing"
    ? "Scoring the submitted copy and preparing calibrated review feedback."
    : processing === "rewriting"
      ? "Creating and validating the latest requested rewrite."
      : "";
  const longReasoningMessage = elapsedSeconds >= 30
    ? ` ${selectedModelDetails.label} is still working at high reasoning effort; complex requests can take several minutes.`
    : "";

  return (
    <div className="workspace" aria-busy={busy}>
      <form className="card input-card" onSubmit={handleReview} noValidate>
        <div className="section-kicker">
          <span>01</span>
          Source input
        </div>
        <div className="section-heading">
          <div>
            <h2>Add the article or draft</h2>
            <p>Paste text or add one public article URL.</p>
          </div>
          <div className="section-heading-tools">
            <span className="privacy-note">Sent to the selected AI provider only when submitted</span>
            <button
              className="model-change-button"
              type="button"
              aria-label={`Change AI model. Current model: ${selectedModelDetails.label}`}
              aria-expanded={modelPickerOpen}
              aria-controls="model-picker"
              onClick={() => setModelPickerOpen((open) => !open)}
              disabled={busy}
            >
              <span>AI model</span>
              <strong>{selectedModelDetails.label}</strong>
              <span className="model-change-action" aria-hidden="true">
                Change
              </span>
            </button>
          </div>
        </div>

        {modelPickerOpen ? (
          <fieldset id="model-picker" className="model-picker" disabled={busy}>
            <legend>Choose the AI model</legend>
            <div className="model-picker-intro">
              <p>Both options use high reasoning for every review and rewrite.</p>
              <span>High reasoning</span>
            </div>
            <div className="model-option-grid">
              {SELECTABLE_MODELS.map((model) => (
                <label
                  className={
                    "model-option " + (selectedModel === model.id ? "model-option-selected" : "")
                  }
                  key={model.id}
                >
                  <input
                    type="radio"
                    name="ai-model"
                    value={model.id}
                    checked={selectedModel === model.id}
                    onChange={() => handleModelChange(model.id)}
                  />
                  <span className="model-option-copy">
                    <span className="model-option-title">
                      <strong>{model.label}</strong>
                      {model.recommended ? <span>Recommended</span> : null}
                    </span>
                    <small>{model.description}</small>
                  </span>
                </label>
              ))}
            </div>
            <div className="model-picker-footer">
              <p>Changing the model requires a new review before rewriting.</p>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => setModelPickerOpen(false)}
              >
                Done
              </button>
            </div>
          </fieldset>
        ) : null}

        <label className="input-label" htmlFor="draft-input">
          News draft or article text
        </label>
        <textarea
          id="draft-input"
          ref={inputRef}
          className={"draft-textarea " + (inputError ? "field-error" : "")}
          value={draft}
          onChange={(event) => {
            if (inFlightRef.current) return;
            draftRef.current = event.target.value;
            setDraft(event.target.value);
            markSourceChanged();
          }}
          placeholder="Paste a report, announcement, or set of news notes…"
          aria-describedby="draft-help draft-count draft-error"
          aria-invalid={Boolean(inputError)}
          maxLength={MAX_DRAFT_CHARS}
          disabled={busy}
        />

        <div className="input-meta">
          <p id="draft-help">The submitted copy is scored separately from external references.</p>
          <p id="draft-count" className="count">
            {words.toLocaleString("en-US")} {words === 1 ? "word" : "words"} ·{" "}
            {draft.length.toLocaleString("en-US")} /{" "}
            {MAX_DRAFT_CHARS.toLocaleString("en-US")} characters
          </p>
        </div>

        <div
          className={
            "file-upload-zone draft-upload-zone " +
            (uploadDragActive ? "file-upload-zone-active" : "") +
            (draftAttachment?.status === "error" ? " file-upload-zone-error" : "")
          }
          onDragEnter={(event) => {
            event.preventDefault();
            if (!busy) setUploadDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            if (!busy) setUploadDragActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setUploadDragActive(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setUploadDragActive(false);
            const file = event.dataTransfer.files?.[0];
            if (file) void processDraftFile(file);
          }}
        >
          <input
            ref={fileInputRef}
            id="draft-file"
            className="visually-hidden-file-input"
            type="file"
            accept={FILE_UPLOAD_ACCEPT}
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void processDraftFile(file);
            }}
          />
          <div>
            <strong>Attach a file or drop it here</strong>
            <p>{SUPPORTED_UPLOAD_HELP}</p>
          </div>
          <label className="button button-secondary file-picker-button" htmlFor="draft-file">
            Choose file
          </label>
        </div>

        {draftAttachment ? (
          <div className="attachment-row draft-attachment-row" aria-live="polite">
            <div className="attachment-icon" aria-hidden="true">DOC</div>
            <div className="attachment-details">
              <strong>{draftAttachment.name}</strong>
              <span>
                {draftAttachment.type} ·{" "}
                {(draftAttachment.size / 1024).toLocaleString("en-US", {
                  maximumFractionDigits: 1,
                })} KB
              </span>
              <span
                className={
                  "attachment-status " +
                  (draftAttachment.status === "error" || draftAttachment.error
                    ? "attachment-status-error"
                    : "")
                }
              >
                {draftAttachment.status === "processing" ? (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    Extracting readable content
                  </>
                ) : draftAttachment.status === "awaiting-choice" ? (
                  draftAttachment.error || "Content extracted — choose how to add it"
                ) : draftAttachment.status === "added" ? (
                  "Content added to the draft editor"
                ) : (
                  draftAttachment.error
                )}
              </span>
              {draftAttachment.truncated ? (
                <span className="attachment-warning">
                  Extracted content was shortened to the 50,000-character editor limit.
                </span>
              ) : null}
            </div>
            <button
              className="button button-quiet attachment-remove"
              type="button"
              onClick={removeDraftAttachment}
              disabled={busy}
            >
              Remove
            </button>
          </div>
        ) : null}

        {draftAttachment?.status === "awaiting-choice" && pendingExtractedText ? (
          <div className="attachment-choice" role="group" aria-label="Add extracted file content">
            <div>
              <strong>Keep the current draft?</strong>
              <p>Append the extracted content, or replace the editor with it.</p>
            </div>
            <div className="attachment-choice-actions">
              <button
                className="button button-secondary"
                type="button"
                onClick={() => applyExtractedContent("append")}
              >
                Append to draft
              </button>
              <button
                className="button button-quiet"
                type="button"
                onClick={() => applyExtractedContent("replace")}
              >
                Replace draft
              </button>
            </div>
          </div>
        ) : null}

        <div className="source-options-grid">
          <div>
            <label className="input-label" htmlFor="source-url">
              Public article URL
            </label>
            <input
              id="source-url"
              type="url"
              value={sourceUrl}
              onChange={(event) => {
                setSourceUrl(event.target.value);
                markSourceChanged();
              }}
              placeholder="https://example.com/article"
              disabled={busy}
            />
            <p className="field-help">The server retrieves a bounded text snapshot.</p>
          </div>

        </div>

        <p id="draft-error" className="field-error-message" role={inputError ? "alert" : undefined}>
          {inputError}
        </p>

        <div className="form-actions">
          <div className="source-action-buttons">
            <button className="button button-primary review-button" type="submit" disabled={busy}>
              {processing === "reviewing" ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Reviewing Draft
                </>
              ) : (
                "Review Draft"
              )}
            </button>
            <button
              className="button button-secondary rewrite-button"
              type="button"
              disabled={busy}
              onClick={() => void handleDirectRewrite()}
            >
              {processing === "rewriting" && !reviewedSource ? (
                <>
                  <span className="spinner spinner-dark" aria-hidden="true" />
                  Rewriting Draft
                </>
              ) : (
                "Rewrite Draft"
              )}
            </button>
          </div>
          <p>
            Pass threshold: {initialPassScore}/100 <span aria-hidden="true">·</span>{" "}
            {selectedModelDetails.label} <span aria-hidden="true">·</span> High reasoning
          </p>
        </div>
      </form>

      {loadingMessage ? (
        <div className="loading-panel" role="status" aria-live="polite">
          <span className="spinner spinner-dark" aria-hidden="true" />
          <div>
            <strong>{processing === "reviewing" ? "Review in progress" : "Rewrite in progress"}</strong>
            <p>{loadingMessage}{longReasoningMessage}</p>
            <span className="loading-elapsed">Elapsed: {formatElapsed(elapsedSeconds)}</span>
          </div>
        </div>
      ) : null}

      {requestError ? (
        <div className="error-panel" role="alert" ref={errorRef} tabIndex={-1}>
          <div className="error-symbol" aria-hidden="true">!</div>
          <div>
            <strong>We could not complete that request</strong>
            <p>{requestError.message}</p>
            {requestError.diagnostics?.stage ? (
              <dl className="error-diagnostics" aria-label="Request diagnostics">
                <div><dt>Stage</dt><dd>{stageLabel(requestError.diagnostics.stage)}</dd></div>
                {requestError.diagnostics.provider ? (
                  <div><dt>Provider</dt><dd>{requestError.diagnostics.provider}</dd></div>
                ) : null}
                {requestError.diagnostics.model ? (
                  <div><dt>Model</dt><dd>{requestError.diagnostics.model}</dd></div>
                ) : null}
                {requestError.diagnostics.httpStatus !== undefined ? (
                  <div>
                    <dt>HTTP status</dt>
                    <dd>{requestError.diagnostics.httpStatus || "No response"}</dd>
                  </div>
                ) : null}
                {requestError.diagnostics.causeSummary ? (
                  <div className="error-cause">
                    <dt>Cause</dt><dd>{requestError.diagnostics.causeSummary}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
            {requestError.retryable && requestError.context === "rewrite" ? (
              <button
                className="button button-secondary"
                type="button"
                onClick={handleRetryRewrite}
                disabled={busy}
              >
                Retry Rewrite
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {review || rewriteState.status === "quotation-failed" || rewriteState.status === "success" ? (
        <div
          className="results-stack"
          ref={resultRef}
          tabIndex={-1}
          role="region"
          aria-label="Review result"
        >
          {review ? (
            <ReviewSummary
              review={review}
              passScore={passScore}
              message={message}
              busy={busy}
              reviewIsStale={reviewIsStale}
              onRewrite={handleInitialRewrite}
              onEditDraft={focusInput}
            />
          ) : null}
          {rewriteState.status === "quotation-failed" ? (
            <QuotationFailurePanel
              issues={rewriteState.issues}
              candidateText={rewriteState.candidateText}
              attempts={rewriteState.attempts}
              busy={busy}
              onRetry={handleRetryRewrite}
            />
          ) : null}
          {rewriteState.status === "success" ? (
            <OutputPanel
              output={rewriteState.text}
              busy={busy}
              copied={copied}
              outputRef={outputRef}
              onCopy={handleCopy}
              onRewriteAgain={handleRewrite}
              onEditInput={focusInput}
              onStartNew={handleStartNew}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
