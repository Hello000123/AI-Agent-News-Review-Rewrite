import { PressReleaseWorkspace } from "@/components/press-release-workspace";
import { getReviewPassScore } from "@/lib/server/config";

export default function Home() {
  const passScore = getReviewPassScore();

  return (
    <main>
      <div id="main-content" className="page-shell">
        <section className="hero" aria-labelledby="page-title">
          <div className="eyebrow">AI news-report assistant</div>
          <h1 id="page-title">
            From rough draft to <span>publication-ready news.</span>
          </h1>
          <p className="hero-copy">
            Get a clear quality assessment and practical feedback first. Then edit the draft
            yourself or ask AI to turn the reviewed version into a news report.
          </p>

          <ol className="workflow-strip" aria-label="Review workflow">
            <li>
              <span>1</span>
              <div>
                <strong>Add your draft</strong>
                <small>Paste or type</small>
              </div>
            </li>
            <li className="workflow-line" aria-hidden="true" />
            <li>
              <span>2</span>
              <div>
                <strong>Get a review</strong>
                <small>Scored out of 100</small>
              </div>
            </li>
            <li className="workflow-line" aria-hidden="true" />
            <li>
              <span>3</span>
              <div>
                <strong>Choose your next step</strong>
                <small>Edit or rewrite with AI</small>
              </div>
            </li>
          </ol>
        </section>

        <PressReleaseWorkspace initialPassScore={passScore} />

        <footer>
          <p>AI can make mistakes. Verify names, dates, quotations, statistics, and attributions.</p>
          <p>No login, publishing, or draft history is included.</p>
        </footer>
      </div>
    </main>
  );
}
