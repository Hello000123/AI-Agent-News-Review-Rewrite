"use client";

import { useState, type FormEvent, type RefObject } from "react";

import {
  MAX_REWRITE_INSTRUCTION_CHARS,
  type RewriteLengthOption,
  type RewriteRefinement,
} from "@/lib/shared/contracts";

interface OutputPanelProps {
  output: string;
  busy: boolean;
  copied: boolean;
  outputRef: RefObject<HTMLTextAreaElement | null>;
  onCopy: () => void;
  onRewriteAgain: (refinement: RewriteRefinement) => void;
  onEditInput: () => void;
  onStartNew: () => void;
}

export function OutputPanel({
  output,
  busy,
  copied,
  outputRef,
  onCopy,
  onRewriteAgain,
  onEditInput,
  onStartNew,
}: OutputPanelProps) {
  const [showRefinement, setShowRefinement] = useState(false);
  const [lengthOption, setLengthOption] = useState<RewriteLengthOption | null>(null);
  const [instruction, setInstruction] = useState("");

  function toggleLengthOption(option: RewriteLengthOption) {
    setLengthOption((current) => (current === option ? null : option));
  }

  function closeRefinement() {
    setShowRefinement(false);
    setLengthOption(null);
    setInstruction("");
  }

  function submitRefinement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onRewriteAgain({ lengthOption, instruction: instruction.trim() });
  }

  return (
    <section className="card output-card" aria-labelledby="output-title">
      <div className="output-heading-row">
        <div>
          <div className="section-kicker">
            <span>03</span>
            Final output
          </div>
          <h2 id="output-title">AI-rewritten news report</h2>
          <p>
            Created from the reviewed draft and its feedback. Verify every name, date, number,
            quotation, attribution, and retained placeholder before publication.
          </p>
        </div>
        <span className="output-badge badge-ai">AI rewritten</span>
      </div>

      <label className="sr-only" htmlFor="final-output">
        Final news report text
      </label>
      <textarea
        id="final-output"
        ref={outputRef}
        className="output-textarea"
        value={output}
        readOnly
        spellCheck={false}
      />

      <div className="output-actions">
        <button className="button button-primary" type="button" onClick={onCopy} disabled={busy}>
          {copied ? "Copied" : "Copy to Clipboard"}
        </button>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => setShowRefinement(true)}
          disabled={busy || showRefinement}
          aria-expanded={showRefinement}
          aria-controls="rewrite-refinement-controls"
        >
          Rewrite with AI Again
        </button>
        <button className="button button-quiet" type="button" onClick={onEditInput} disabled={busy}>
          Edit draft myself
        </button>
        <button className="button button-quiet" type="button" onClick={onStartNew} disabled={busy}>
          Start New Draft
        </button>
      </div>
      {showRefinement ? (
        <form
          id="rewrite-refinement-controls"
          className="rewrite-refinement"
          onSubmit={submitRefinement}
        >
          <div className="refinement-heading">
            <div>
              <h3>Refine the next rewrite</h3>
              <p>Length options are optional. Choose one or leave both unselected.</p>
            </div>
          </div>

          <span className="input-label" id="rewrite-length-label">
            Length and detail <span className="optional-label">(optional)</span>
          </span>
          <div
            className="length-option-group"
            role="group"
            aria-labelledby="rewrite-length-label"
          >
            <button
              className="length-option"
              type="button"
              aria-pressed={lengthOption === "concise"}
              onClick={() => toggleLengthOption("concise")}
              disabled={busy}
            >
              Concise
            </button>
            <button
              className="length-option"
              type="button"
              aria-pressed={lengthOption === "more_detailed"}
              onClick={() => toggleLengthOption("more_detailed")}
              disabled={busy}
            >
              More detailed
            </button>
          </div>

          <label className="input-label" htmlFor="rewrite-instructions">
            Improvement instructions <span className="optional-label">(optional)</span>
          </label>
          <textarea
            id="rewrite-instructions"
            className="refinement-instructions"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="Describe how you want the article improved"
            maxLength={MAX_REWRITE_INSTRUCTION_CHARS}
            disabled={busy}
          />

          <div className="refinement-actions">
            <button className="button button-primary" type="submit" disabled={busy}>
              Rewrite Again
            </button>
            <button
              className="button button-quiet"
              type="button"
              onClick={closeRefinement}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <p className="copy-status" role="status" aria-live="polite">
        {copied ? "The final news report was copied to your clipboard." : ""}
      </p>
    </section>
  );
}
