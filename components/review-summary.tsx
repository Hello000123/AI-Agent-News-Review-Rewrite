import type { CSSProperties } from "react";

import type { ReviewResult } from "@/lib/shared/contracts";

interface ReviewSummaryProps {
  review: ReviewResult;
  passScore: number;
  message: string;
  busy: boolean;
  wasRewritten: boolean;
  onRewriteAnyway: () => void;
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
  wasRewritten,
  onRewriteAnyway,
}: ReviewSummaryProps) {
  const passed = review.overallScore >= passScore;
  const scores: ScoreItem[] = [
    { label: "Content & announcement (40%)", score: review.contentScore },
    { label: "Clarity & readability (20%)", score: review.clarityScore },
    { label: "Structure & organisation (20%)", score: review.structureScore },
    { label: "Professional tone (15%)", score: review.toneScore },
    { label: "Grammar & mechanics (5%)", score: review.writingScore },
  ];
  const scoreReasons = [
    "Content & announcement: " + review.scoreReasons.content,
    "Clarity & readability: " + review.scoreReasons.clarity,
    "Structure & organisation: " + review.scoreReasons.structure,
    "Professional tone: " + review.scoreReasons.tone,
    "Grammar & mechanics: " + review.scoreReasons.writing,
  ];
  const scoreStyle = { "--score": rounded(review.overallScore) + "%" } as CSSProperties;

  return (
    <section className="card review-card" aria-labelledby="review-title">
      <div className="section-kicker">
        <span>02</span>
        Review result
      </div>

      <div className={"decision-banner " + (passed ? "decision-pass" : "decision-rewrite")}>
        <div className="score-ring" style={scoreStyle} aria-label={rounded(review.overallScore) + " out of 100"}>
          <div className="score-ring-inner">
            <strong>{rounded(review.overallScore)}</strong>
            <span>/ 100</span>
          </div>
        </div>
        <div className="decision-copy">
          <div className="decision-label">
            <span className="status-dot" aria-hidden="true" />
            {passed ? "Passed review" : "Rewrite required"}
          </div>
          <h2 id="review-title">{passed ? "Your draft is ready to use" : "Your draft has been improved"}</h2>
          <p>{message}</p>
          <p className="threshold-note">Pass threshold: {passScore}/100</p>
        </div>
        {passed && !wasRewritten ? (
          <button
            className="button button-secondary decision-action"
            type="button"
            onClick={onRewriteAnyway}
            disabled={busy}
          >
            Rewrite Anyway
          </button>
        ) : null}
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
        <FeedbackList title="Problems" items={review.problems} variant="warning" />
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
