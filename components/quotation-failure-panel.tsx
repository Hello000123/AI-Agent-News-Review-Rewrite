import type { QuotationIssue } from "@/lib/shared/contracts";

interface QuotationFailurePanelProps {
  issues: QuotationIssue[];
  candidateText?: string;
  attempts?: number;
  busy: boolean;
  onRetry: () => void;
}

const problemLabels: Record<QuotationIssue["kind"], string> = {
  modified: "Quoted wording was modified",
  omitted: "Quotation was omitted",
  split: "Quotation was split",
  merged: "Quotation was merged",
  punctuation_changed: "Punctuation inside the quotation changed",
};

export function QuotationFailurePanel({
  issues,
  candidateText,
  attempts,
  busy,
  onRetry,
}: QuotationFailurePanelProps) {
  return (
    <section className="card quotation-failure-card" aria-labelledby="quotation-failure-title">
      <div className="section-kicker">
        <span>!</span>
        Quotation check
      </div>
      <h2 id="quotation-failure-title">Rewrite needs quotation correction</h2>
      <p>
        The generated article is not marked as final. The automatic correction was limited to one
        retry{attempts ? ` (${attempts} total attempts)` : ""} to avoid a retry loop.
      </p>

      <div className="quotation-issue-list">
        {issues.map((issue, index) => (
          <article className="quotation-issue" key={`${issue.sourceParagraph}-${index}`}>
            <h3>
              Paragraph {issue.sourceParagraph}: {problemLabels[issue.kind]}
            </h3>
            <dl>
              <div>
                <dt>Original</dt>
                <dd>{issue.original}</dd>
              </div>
              <div>
                <dt>Rewrite</dt>
                <dd>{issue.rewrite ?? "No corresponding quotation was found."}</dd>
              </div>
              <div>
                <dt>Problem</dt>
                <dd>{issue.differenceSummary}</dd>
              </div>
              <div>
                <dt>Action</dt>
                <dd>{issue.action}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>

      {candidateText ? (
        <div className="candidate-draft">
          <label htmlFor="quotation-candidate">Generated draft — not validated for publication</label>
          <textarea id="quotation-candidate" value={candidateText} readOnly spellCheck={false} />
        </div>
      ) : null}

      <button className="button button-primary" type="button" onClick={onRetry} disabled={busy}>
        Retry Rewrite
      </button>
    </section>
  );
}
