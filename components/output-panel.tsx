import type { RefObject } from "react";

interface OutputPanelProps {
  output: string;
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
          onClick={onRewriteAgain}
          disabled={busy}
        >
          Rewrite with AI again
        </button>
        <button className="button button-quiet" type="button" onClick={onEditInput} disabled={busy}>
          Edit draft myself
        </button>
        <button className="button button-quiet" type="button" onClick={onStartNew} disabled={busy}>
          Start New Draft
        </button>
      </div>
      <p className="copy-status" role="status" aria-live="polite">
        {copied ? "The final news report was copied to your clipboard." : ""}
      </p>
    </section>
  );
}
