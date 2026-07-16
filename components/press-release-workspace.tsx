"use client";

import { useEffect, useRef, useState } from "react";

import { OutputPanel } from "@/components/output-panel";
import { QuotationFailurePanel } from "@/components/quotation-failure-panel";
import { ReviewSummary } from "@/components/review-summary";
import { ApiRequestError, requestReview, requestRewrite } from "@/lib/client/api";
import {
  MAX_DRAFT_CHARS,
  type EditorialInput,
  type OutputLanguage,
  type QuotationIssue,
  type ReviewResult,
  type SourceSnapshot,
} from "@/lib/shared/contracts";

type ProcessingState = "idle" | "reviewing" | "rewriting";

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
}

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
    imageContext: input.imageContext,
  });
}

export function PressReleaseWorkspace({ initialPassScore }: PressReleaseWorkspaceProps) {
  const [draft, setDraft] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [imageFiles, setImageFiles] = useState<string[]>([]);
  const [imageNotes, setImageNotes] = useState("");
  const [outputLanguage, setOutputLanguage] = useState<OutputLanguage>("original");
  const [reviewedInputSignature, setReviewedInputSignature] = useState("");
  const [reviewedSource, setReviewedSource] = useState<SourceSnapshot | null>(null);
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [rewriteState, setRewriteState] = useState<RewriteState>({ status: "idle" });
  const [message, setMessage] = useState("");
  const [passScore, setPassScore] = useState(initialPassScore);
  const [processing, setProcessing] = useState<ProcessingState>("idle");
  const [inputError, setInputError] = useState("");
  const [requestError, setRequestError] = useState<VisibleError | null>(null);
  const [copied, setCopied] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const outputRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const inFlightRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const activeRequestRef = useRef(0);
  const busy = processing !== "idle";
  const words = countWords(draft);

  useEffect(() => {
    if (processing === "idle") return;

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [processing]);

  function currentInput(): EditorialInput {
    return {
      draft,
      sourceUrl,
      imageContext: imageNotes.trim()
        ? [
            {
              label: imageFiles.length ? imageFiles.join(", ") : "Supporting visual notes",
              text: imageNotes.trim(),
              source: "user_caption",
            },
          ]
        : [],
      outputLanguage,
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
    setMessage("");
    setPassScore(initialPassScore);
    setCopied(false);
    setRequestError(null);
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
    setCopied(false);
  }

  function validateInput(input: EditorialInput) {
    if (!input.draft.trim() && !input.sourceUrl.trim() && input.imageContext.length === 0) {
      return "Enter draft text, a source URL, or supported image text before requesting a review.";
    }
    if (input.draft.length > MAX_DRAFT_CHARS) {
      return "Drafts are limited to 50,000 characters.";
    }
    if (imageFiles.length > 0 && !imageNotes.trim()) {
      return "Add an accurate caption or OCR text for the selected image files.";
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

  async function handleRewrite() {
    if (inFlightRef.current || !review || !reviewedSource || reviewIsStale) return;

    const requestId = ++requestSequenceRef.current;
    activeRequestRef.current = requestId;
    inFlightRef.current = true;
    setRequestError(null);
    setCopied(false);
    setRewriteState({ status: "loading", attemptId: requestId });
    setElapsedSeconds(0);
    setProcessing("rewriting");

    try {
      const result = await requestRewrite(reviewedSource, review, outputLanguage);
      if (activeRequestRef.current !== requestId) return;
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
    setDraft("");
    setSourceUrl("");
    setImageFiles([]);
    setImageNotes("");
    setOutputLanguage("original");
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
    ? " DeepSeek V4 Pro is still working at maximum reasoning effort; complex requests can take several minutes."
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
            <p>Paste text, add one public article URL, and include relevant image captions or OCR.</p>
          </div>
          <span className="privacy-note">Sent to DeepSeek only when submitted</span>
        </div>

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
            <p className="field-help">The server retrieves a bounded text snapshot and image captions.</p>
          </div>

          <div>
            <label className="input-label" htmlFor="output-language">
              Output language
            </label>
            <select
              id="output-language"
              value={outputLanguage}
              onChange={(event) => {
                setOutputLanguage(event.target.value as OutputLanguage);
                setRewriteState({ status: "idle" });
                setCopied(false);
                setRequestError(null);
              }}
              disabled={busy}
            >
              <option value="original">Keep original language</option>
              <option value="traditional_chinese">Traditional Chinese (Hong Kong)</option>
              <option value="english">English</option>
            </select>
          </div>
        </div>

        <label className="input-label" htmlFor="image-files">
          Supporting images (optional)
        </label>
        <input
          id="image-files"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={(event) => {
            setImageFiles(Array.from(event.target.files ?? [], ({ name }) => name).slice(0, 8));
            markSourceChanged();
          }}
          disabled={busy}
        />
        <p className="field-help">
          DeepSeek V4 is text-only. Image bytes stay in this browser; add an accurate caption or OCR
          transcript below so the agents receive the relevant visual content.
        </p>

        <label className="input-label" htmlFor="image-notes">
          Image captions or OCR text
        </label>
        <textarea
          id="image-notes"
          className="context-textarea"
          value={imageNotes}
          onChange={(event) => {
            setImageNotes(event.target.value);
            markSourceChanged();
          }}
          placeholder="Describe only facts visibly supported by the image, or paste verified OCR text."
          disabled={busy}
          maxLength={4_000}
        />

        <p id="draft-error" className="field-error-message" role={inputError ? "alert" : undefined}>
          {inputError}
        </p>

        <div className="form-actions">
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
          <p>Pass threshold: {initialPassScore}/100</p>
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
              <button className="button button-secondary" type="button" onClick={handleRewrite} disabled={busy}>
                Retry Rewrite
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {review ? (
        <div
          className="results-stack"
          ref={resultRef}
          tabIndex={-1}
          role="region"
          aria-label="Review result"
        >
          <ReviewSummary
            review={review}
            passScore={passScore}
            message={message}
            busy={busy}
            reviewIsStale={reviewIsStale}
            onRewrite={handleRewrite}
            onEditDraft={focusInput}
          />
          {rewriteState.status === "quotation-failed" ? (
            <QuotationFailurePanel
              issues={rewriteState.issues}
              candidateText={rewriteState.candidateText}
              attempts={rewriteState.attempts}
              busy={busy}
              onRetry={handleRewrite}
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
