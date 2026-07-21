import type { CSSProperties } from "react";

import type { ReviewResult } from "@/lib/shared/contracts";

interface ReviewSummaryProps {
  review: ReviewResult;
  passScore: number;
  message: string;
  busy: boolean;
  reviewIsStale: boolean;
  onRewrite: () => void;
  onEditDraft: () => void;
}

interface ScoreItem {
  label: string;
  score: number;
}

function rounded(score: number) {
  return Math.round(score);
}

function FeedbackList({
  title,
  items,
  variant,
}: {
  title: string;
  items: string[];
  variant: "positive" | "warning" | "neutral";
}) {
  return (
    <section className={"feedback-block feedback-" + variant}>
      <div className="feedback-heading">
        <span className="feedback-marker" aria-hidden="true" />
        <h3>{title}</h3>
      </div>
      {items.length > 0 ? (
        <ul>
          {items.map((item, index) => (
            <li key={title + "-" + index}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="empty-feedback">None identified.</p>
      )}
    </section>
  );
}

export function ReviewSummary({
  review,
  passScore,
  message,
  busy,
  reviewIsStale,
  onRewrite,
  onEditDraft,
}: ReviewSummaryProps) {
  const passed = review.decision === "PASS";
  const scores: ScoreItem[] = [
    { label: "Facts & support (25%)", score: review.factualCompletenessScore },
    { label: "Structure & organisation (20%)", score: review.structureScore },
    { label: "Clarity & readability (15%)", score: review.clarityScore },
    { label: "Grammar & language (15%)", score: review.languageQualityScore },
    { label: "News professionalism (15%)", score: review.professionalismScore },
    { label: "Attribution & quotations (10%)", score: review.attributionScore },
  ];
  const scoreReasons = [
    "Facts & support: " + review.scoreReasons.factualCompleteness,
    "Structure & organisation: " + review.scoreReasons.structure,
    "Clarity & readability: " + review.scoreReasons.clarity,
    "Grammar & language: " + review.scoreReasons.languageQuality,
    "News professionalism: " + review.scoreReasons.professionalism,
    "Attribution & quotations: " + review.scoreReasons.attribution,
  ];
  const findings = review.findings.map(
    ({ category, severity, issue, evidence, recommendation }) =>
      `[${category} — ${severity}] ${issue} Evidence: ${evidence} Action: ${recommendation}`,
  );
  const readinessLabel = {
    PUBLICATION_READY: "Publication-ready",
    STRONG_LIMITED_EDITING: "Strong — limited editing needed",
    SUBSTANTIAL_REWRITE: "Usable — substantial rewrite needed",
    WEAK: "Weak draft",
    SEVERELY_DEFICIENT: "Severely deficient",
  }[review.readinessBand];
  const scoreStyle = { "--score": rounded(review.overallScore) + "%" } as CSSProperties;

  return (
    <section className="card review-card" aria-labelledby="review-title">
      <div className="section-kicker">
        <span>02</span>
        Review result
      </div>

      {reviewIsStale ? (
        <div className="stale-review-note" id="stale-review-note" role="status">
          <span aria-hidden="true">!</span>
          <div>
            <strong>Review applies to an earlier version</strong>
            <p>
              You changed the draft or source URL after this review. Review the updated source
              input again before requesting an AI rewrite.
            </p>
          </div>
        </div>
      ) : null}

      <div className={"decision-banner " + (passed ? "decision-pass" : "decision-rewrite")}>
        <div
          className="score-ring"
          style={scoreStyle}
          aria-label={rounded(review.overallScore) + " out of 100"}
        >
          <div className="score-ring-inner">
            <strong>{rounded(review.overallScore)}</strong>
            <span>/ 100</span>
          </div>
        </div>
        <div className="decision-copy">
          <div className="decision-label">
            <span className="status-dot" aria-hidden="true" />
            {passed ? "Passed review" : "Below pass threshold"}
          </div>
          <h2 id="review-title">
            {passed ? "Review complete" : "Review complete — changes recommended"}
          </h2>
          <p>{message}</p>
          <p className="readiness-note">Readiness: {readinessLabel}</p>
          <p className="threshold-note">Pass threshold: {passScore}/100</p>
          {review.appliedScoreCap !== null ? (
            <p className="threshold-note">
              Consistency cap: {review.appliedScoreCap}/100 — {review.scoreCapReasons.join(" ")}
            </p>
          ) : null}
        </div>
        <div className="decision-actions">
          <button
            className="button button-primary"
            type="button"
            onClick={onRewrite}
            disabled={busy || reviewIsStale}
            aria-describedby={reviewIsStale ? "stale-review-note" : undefined}
          >
            Rewrite with AI
          </button>
          <button
            className="button button-secondary"
            type="button"
            onClick={onEditDraft}
            disabled={busy}
          >
            Edit draft myself
          </button>
        </div>
      </div>

      <div className="score-grid" aria-label="Category scores">
        {scores.map((item) => (
          <div className="score-tile" key={item.label}>
            <div className="score-tile-top">
              <span>{item.label}</span>
              <strong>{rounded(item.score)}</strong>
            </div>
            <div className="score-track" aria-hidden="true">
              <span style={{ width: rounded(item.score) + "%" }} />
            </div>
          </div>
        ))}
      </div>

      <div className="feedback-grid">
        <FeedbackList title="Score rationale" items={scoreReasons} variant="neutral" />
        <FeedbackList title="Strengths" items={review.strengths} variant="positive" />
        <FeedbackList title="Findings" items={findings} variant="warning" />
        <FeedbackList
          title="Missing or unclear information"
          items={review.missingInformation}
          variant="warning"
        />
        <FeedbackList
          title="Recommended improvements"
          items={review.recommendations}
          variant="neutral"
        />
      </div>
    </section>
  );
}
