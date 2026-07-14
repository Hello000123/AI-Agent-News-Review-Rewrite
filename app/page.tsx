import { PressReleaseWorkspace } from "@/components/press-release-workspace";
import { getReviewPassScore } from "@/lib/server/config";

export default function Home() {
  const passScore = getReviewPassScore();

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#main-content" aria-label="PressReady home">
          <span className="brand-mark" aria-hidden="true">
            PR
          </span>
          <span>PressReady</span>
        </a>
        <span className="header-note">
          <span aria-hidden="true">●</span> Facts preserved
        </span>
      </header>

      <div id="main-content" className="page-shell">
        <section className="hero" aria-labelledby="page-title">
          <div className="eyebrow">AI press release assistant</div>
          <h1 id="page-title">
            From rough draft to <span>press-ready.</span>
          </h1>
          <p className="hero-copy">
            Get a clear quality assessment, practical feedback, and an automatic professional
            rewrite when your draft needs work.
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
                <strong>Use the best version</strong>
                <small>Original or rewritten</small>
              </div>
            </li>
          </ol>
        </section>

        <PressReleaseWorkspace initialPassScore={passScore} />

        <footer>
          <p>AI can make mistakes. Verify names, dates, quotations, statistics, and contact details.</p>
          <p>No login, publishing, or draft history is included.</p>
        </footer>
      </div>
    </main>
  );
}
