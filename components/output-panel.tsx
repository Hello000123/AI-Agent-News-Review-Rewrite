import type { RefObject } from "react";

interface OutputPanelProps {
  output: string;
  wasRewritten: boolean;
  busy: boolean;
  copied: boolean;
  outputRef: RefObject<HTMLTextAreaElement | null>;
  onCopy: () => void;
  onRewriteAgain: () => void;
  onEditInput: () => void;
  onStartNew: () => void;
}

export function OutputPanel({
  output,
  wasRewritten,
  busy,
  copied,
  outputRef,
  onCopy,
  onRewriteAgain,
  onEditInput,
  onStartNew,
}: OutputPanelProps) {
  return (
    <section className="card output-card" aria-labelledby="output-title">
      <div className="output-heading-row">
        <div>
          <div className="section-kicker">
            <span>03</span>
            Final output
          </div>
          <h2 id="output-title">Recommended press release</h2>
          <p>
            {wasRewritten
              ? "AI-rewritten using the review feedback. Check every placeholder before use."
              : "The original draft is recommended because it passed the quality threshold."}
          </p>
        </div>
        <span className={"output-badge " + (wasRewritten ? "badge-ai" : "badge-original")}>
          {wasRewritten ? "AI rewritten" : "Original draft"}
        </span>
      </div>

      <label className="sr-only" htmlFor="final-output">
        Final press release text
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
          onClick={onRewriteAgain}
          disabled={busy}
        >
          Rewrite Again
        </button>
        <button className="button button-quiet" type="button" onClick={onEditInput} disabled={busy}>
          Edit Input
        </button>
        <button className="button button-quiet" type="button" onClick={onStartNew} disabled={busy}>
          Start New Draft
        </button>
      </div>
      <p className="copy-status" role="status" aria-live="polite">
        {copied ? "The final press release was copied to your clipboard." : ""}
      </p>
    </section>
  );
}
