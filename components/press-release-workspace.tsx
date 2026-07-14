"use client";

import { useRef, useState } from "react";

import { OutputPanel } from "@/components/output-panel";
import { ReviewSummary } from "@/components/review-summary";
import { ApiRequestError, requestReview, requestRewrite } from "@/lib/client/api";
import { MAX_DRAFT_CHARS, type ReviewResult } from "@/lib/shared/contracts";

type ProcessingState = "idle" | "reviewing" | "rewriting";

interface PressReleaseWorkspaceProps {
  initialPassScore: number;
}

function countWords(text: string) {
  const normalized = text.trim();
  return normalized ? normalized.split(/\s+/u).length : 0;
}

function errorMessage(error: unknown) {
  if (error instanceof ApiRequestError) return error.message;
  return "Something went wrong while processing the draft. Please try again.";
}

export function PressReleaseWorkspace({ initialPassScore }: PressReleaseWorkspaceProps) {
  const [draft, setDraft] = useState("");
  const [submittedDraft, setSubmittedDraft] = useState("");
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [finalText, setFinalText] = useState("");
  const [message, setMessage] = useState("");
  const [passScore, setPassScore] = useState(initialPassScore);
  const [wasRewritten, setWasRewritten] = useState(false);
  const [processing, setProcessing] = useState<ProcessingState>("idle");
  const [inputError, setInputError] = useState("");
  const [requestError, setRequestError] = useState("");
  const [copied, setCopied] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const outputRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const busy = processing !== "idle";
  const words = countWords(draft);

  function clearResults() {
    setReview(null);
    setFinalText("");
    setMessage("");
    setWasRewritten(false);
    setCopied(false);
    setRequestError("");
  }

  function focusInput() {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.scrollIntoView({ block: "center" });
    });
  }

  function showRequestError(message: string) {
    setRequestError(message);
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  function handleDraftChange(value: string) {
    if (review) clearResults();
    else setRequestError("");
    setDraft(value);
    setInputError("");
  }

  async function handleReview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    if (!draft.trim()) {
      setInputError("Enter a draft before requesting a review.");
      inputRef.current?.focus();
      return;
    }
    if (draft.length > MAX_DRAFT_CHARS) {
      setInputError("Drafts are limited to 50,000 characters.");
      inputRef.current?.focus();
      return;
    }

    setInputError("");
    clearResults();
    setProcessing("reviewing");

    try {
      const result = await requestReview(draft);
      setSubmittedDraft(draft);
      setReview(result.review);
      setFinalText(result.finalText);
      setMessage(result.message);
      setPassScore(result.passScore);
      setWasRewritten(result.wasRewritten);
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (error) {
      showRequestError(errorMessage(error));
    } finally {
      setProcessing("idle");
    }
  }

  async function handleRewrite() {
    if (busy || !review || !submittedDraft) return;

    setRequestError("");
    setCopied(false);
    setProcessing("rewriting");
    try {
      const result = await requestRewrite(submittedDraft, review);
      setFinalText(result.finalText);
      setWasRewritten(true);
      setMessage("A new version was created from the original draft and review feedback.");
      requestAnimationFrame(() => outputRef.current?.focus());
    } catch (error) {
      showRequestError(errorMessage(error));
    } finally {
      setProcessing("idle");
    }
  }

  async function handleCopy() {
    if (!finalText) return;
    setRequestError("");

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
      showRequestError(
        "The browser could not copy the output. Select the text and copy it manually.",
      );
    }
  }

  function handleEditInput() {
    clearResults();
    focusInput();
  }

  function handleStartNew() {
    setDraft("");
    setSubmittedDraft("");
    setInputError("");
    clearResults();
    focusInput();
  }

  const loadingMessage =
    processing === "reviewing"
      ? "Reviewing your draft and rewriting it automatically if needed…"
      : processing === "rewriting"
        ? "Creating a new professional rewrite…"
        : "";

  return (
    <div className="workspace" aria-busy={busy}>
      <form className="card input-card" onSubmit={handleReview} noValidate>
        <div className="section-kicker">
          <span>01</span>
          Draft input
        </div>
        <div className="section-heading">
          <div>
            <h2>Paste your draft</h2>
            <p>
              Add the full announcement, including any quotes, dates, locations, and contact
              details you already have.
            </p>
          </div>
          <span className="privacy-note">Sent to DeepSeek only when submitted</span>
        </div>

        <label className="input-label" htmlFor="draft-input">
          Press release draft <span aria-hidden="true">*</span>
        </label>
        <textarea
          id="draft-input"
          ref={inputRef}
          className={"draft-textarea " + (inputError ? "field-error" : "")}
          value={draft}
          onChange={(event) => handleDraftChange(event.target.value)}
          placeholder="Example: [Company Name] today announced a new initiative that…"
          aria-describedby="draft-help draft-count draft-error"
          aria-invalid={Boolean(inputError)}
          aria-required="true"
          maxLength={MAX_DRAFT_CHARS}
          required
          disabled={busy}
        />

        <div className="input-meta">
          <p id="draft-help">Include only supported facts. Missing details can be added as placeholders.</p>
          <p id="draft-count" className="count">
            {words.toLocaleString("en-US")} {words === 1 ? "word" : "words"} ·{" "}
            {draft.length.toLocaleString("en-US")} /{" "}
            {MAX_DRAFT_CHARS.toLocaleString("en-US")} characters
          </p>
        </div>
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
            <p>{loadingMessage}</p>
          </div>
        </div>
      ) : null}

      {requestError ? (
        <div className="error-panel" role="alert" ref={errorRef} tabIndex={-1}>
          <div className="error-symbol" aria-hidden="true">
            !
          </div>
          <div>
            <strong>We could not complete that request</strong>
            <p>{requestError}</p>
          </div>
        </div>
      ) : null}

      {review && finalText ? (
        <div
          className="results-stack"
          ref={resultRef}
          tabIndex={-1}
          role="region"
          aria-label="Review result and final output"
        >
          <ReviewSummary
            review={review}
            passScore={passScore}
            message={message}
            busy={busy}
            wasRewritten={wasRewritten}
            onRewriteAnyway={handleRewrite}
          />
          <OutputPanel
            output={finalText}
            wasRewritten={wasRewritten}
            busy={busy}
            copied={copied}
            outputRef={outputRef}
            onCopy={handleCopy}
            onRewriteAgain={handleRewrite}
            onEditInput={handleEditInput}
            onStartNew={handleStartNew}
          />
        </div>
      ) : null}
    </div>
  );
}
