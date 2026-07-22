// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PressReleaseWorkspace } from "@/components/press-release-workspace";
import { ApiRequestError, requestReview, requestRewrite } from "@/lib/client/api";
import { REWRITE_SESSION_STORAGE_KEY } from "@/lib/client/rewrite-session";
import type {
  ReviewApiResponse,
  RewriteApiResponse,
  RewriteLengthOption,
  SourceSnapshot,
} from "@/lib/shared/contracts";
import { highReview, lowReview } from "@/tests/fixtures/reviews";

vi.mock("@/lib/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client/api")>();
  return {
    ...actual,
    requestReview: vi.fn(),
    requestRewrite: vi.fn(),
  };
});

const reviewMock = vi.mocked(requestReview);
const rewriteMock = vi.mocked(requestRewrite);

function sourceFor(text: string): SourceSnapshot {
  return { primaryText: text, userDraft: text, imageContext: [] };
}

function reviewResponse(review = highReview, text = "Original supported facts."): ReviewApiResponse {
  return {
    review,
    source: sourceFor(text),
    passScore: 80,
    message: "Review complete. Choose how to continue.",
  };
}

function rewriteResponse(finalText: string): RewriteApiResponse {
  return { finalText, validation: { status: "passed", attempts: 1 } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type TestUser = ReturnType<typeof userEvent.setup>;

async function submitReview(user: TestUser, text: string) {
  await user.type(screen.getByRole("textbox", { name: /News draft/u }), text);
  await user.click(screen.getByRole("button", { name: "Review Draft" }));
  await screen.findByText("Score rationale");
}

async function openRefinement(user: TestUser) {
  await user.click(screen.getByRole("button", { name: "Rewrite with AI Again" }));
  return screen.findByRole("heading", { name: "Refine the next rewrite" });
}

async function submitRefinement(
  user: TestUser,
  options: { lengthOption?: RewriteLengthOption; instruction?: string } = {},
) {
  await openRefinement(user);
  if (options.lengthOption) {
    await user.click(
      screen.getByRole("button", {
        name: options.lengthOption === "concise" ? "Concise" : "More detailed",
      }),
    );
  }
  if (options.instruction) {
    await user.type(screen.getByLabelText(/Improvement instructions/u), options.instruction);
  }
  await user.click(screen.getByRole("button", { name: "Rewrite Again" }));
}

describe("score-first workspace", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["passing", highReview],
    ["failing", lowReview],
  ])("renders the complete %s review and always offers rewrite", async (_label, review) => {
    reviewMock.mockResolvedValue(reviewResponse(review));
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    const editor = screen.getByRole("textbox", { name: /News draft/u });
    await user.type(editor, "Original supported facts.");
    await user.click(screen.getByRole("button", { name: "Review Draft" }));

    expect(await screen.findByText("Score rationale")).toBeTruthy();
    expect(screen.getByLabelText(`${Math.round(review.overallScore)} out of 100`)).toBeTruthy();
    expect(
      screen.getByText(review.scoreReasons.factualCompleteness, { exact: false }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rewrite with AI" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "AI-rewritten news report" })).toBeNull();
    expect(reviewMock).toHaveBeenCalledWith({
      draft: "Original supported facts.",
      sourceUrl: "",
    });
    expect(rewriteMock).not.toHaveBeenCalled();
  });

  it("sends the URL without exposing picture or output-language inputs", async () => {
    reviewMock.mockResolvedValue(reviewResponse(highReview, "Retrieved article text."));
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    expect(screen.queryByLabelText("Supporting images (optional)")).toBeNull();
    expect(screen.queryByLabelText("Image captions or OCR text")).toBeNull();
    expect(screen.queryByLabelText("Output language")).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();

    await user.type(screen.getByLabelText("Public article URL"), "https://example.com/article");
    await user.click(screen.getByRole("button", { name: "Review Draft" }));

    await screen.findByText("Score rationale");
    expect(reviewMock).toHaveBeenCalledWith({
      draft: "",
      sourceUrl: "https://example.com/article",
    });
  });

  it("makes a separate rewrite request from the immutable reviewed source even for a high score", async () => {
    const reviewedSource = sourceFor("Immutable reviewed facts.");
    reviewMock.mockResolvedValue({ ...reviewResponse(highReview), source: reviewedSource });
    rewriteMock.mockResolvedValue(
      rewriteResponse("Accurate headline\n\nA publication-quality news report."),
    );
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    await user.type(screen.getByRole("textbox", { name: /News draft/u }), "Immutable reviewed facts.");
    await user.click(screen.getByRole("button", { name: "Review Draft" }));
    await screen.findByText("Score rationale");
    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));

    expect((await screen.findByLabelText("Final news report text") as HTMLTextAreaElement).value)
      .toBe("Accurate headline\n\nA publication-quality news report.");
    expect(rewriteMock).toHaveBeenCalledWith(
      reviewedSource,
      highReview,
      [],
      { lengthOption: null, instruction: "" },
    );
  });

  it("opens optional refinement controls without rewriting and submits no preference or comment", async () => {
    const reviewedSource = sourceFor("Optional refinement facts.");
    const firstText = "First headline\n\nFirst rewritten report.";
    const secondText = "Second headline\n\nSecond rewritten report.";
    reviewMock.mockResolvedValue({
      ...reviewResponse(highReview, reviewedSource.primaryText),
      source: reviewedSource,
    });
    rewriteMock
      .mockResolvedValueOnce(rewriteResponse(firstText))
      .mockResolvedValueOnce(rewriteResponse(secondText));
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    await submitReview(user, reviewedSource.primaryText);
    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));
    expect((await screen.findByLabelText("Final news report text") as HTMLTextAreaElement).value)
      .toBe(firstText);

    await openRefinement(user);
    expect(rewriteMock).toHaveBeenCalledOnce();
    expect((screen.getByLabelText("Final news report text") as HTMLTextAreaElement).value)
      .toBe(firstText);
    expect(screen.getByText("Length options are optional. Choose one or leave both unselected."))
      .toBeTruthy();
    expect(screen.getByRole("button", { name: "Concise" }).getAttribute("aria-pressed"))
      .toBe("false");
    expect(screen.getByRole("button", { name: "More detailed" }).getAttribute("aria-pressed"))
      .toBe("false");
    expect((screen.getByLabelText(/Improvement instructions/u) as HTMLTextAreaElement).value)
      .toBe("");

    await user.click(screen.getByRole("button", { name: "Rewrite Again" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Final news report text") as HTMLTextAreaElement).value)
        .toBe(secondText),
    );
    expect(rewriteMock).toHaveBeenNthCalledWith(
      2,
      reviewedSource,
      highReview,
      [{ rewrittenText: firstText, lengthOption: null, instruction: "" }],
      { lengthOption: null, instruction: "" },
    );
  });

  it("keeps length options mutually exclusive and lets the user deselect the active option", async () => {
    reviewMock.mockResolvedValue(reviewResponse(highReview, "Toggle refinement facts."));
    rewriteMock.mockResolvedValue(rewriteResponse("Toggle headline\n\nToggle report."));
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    await submitReview(user, "Toggle refinement facts.");
    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));
    await screen.findByLabelText("Final news report text");
    await openRefinement(user);

    const concise = screen.getByRole("button", { name: "Concise" });
    const detailed = screen.getByRole("button", { name: "More detailed" });
    await user.click(concise);
    expect(concise.getAttribute("aria-pressed")).toBe("true");
    expect(detailed.getAttribute("aria-pressed")).toBe("false");

    await user.click(detailed);
    expect(concise.getAttribute("aria-pressed")).toBe("false");
    expect(detailed.getAttribute("aria-pressed")).toBe("true");

    await user.click(detailed);
    expect(concise.getAttribute("aria-pressed")).toBe("false");
    expect(detailed.getAttribute("aria-pressed")).toBe("false");
    expect(rewriteMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["Concise", "concise", "", "concise"],
    ["More detailed", "more_detailed", "", "more_detailed"],
    ["instruction only", undefined, "Use a more formal tone.", null],
    ["length and instruction", "concise", "Reduce repeated information.", "concise"],
  ] as const)(
    "submits %s refinement",
    async (_label, selectedOption, instruction, expectedOption) => {
      const reviewedSource = sourceFor("Parameterized refinement facts.");
      const firstText = "Baseline headline\n\nBaseline rewritten report.";
      const nextText = "Refined headline\n\nRefined rewritten report.";
      reviewMock.mockResolvedValue({
        ...reviewResponse(highReview, reviewedSource.primaryText),
        source: reviewedSource,
      });
      rewriteMock
        .mockResolvedValueOnce(rewriteResponse(firstText))
        .mockResolvedValueOnce(rewriteResponse(nextText));
      const user = userEvent.setup();
      render(<PressReleaseWorkspace initialPassScore={80} />);

      await submitReview(user, reviewedSource.primaryText);
      await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));
      await screen.findByLabelText("Final news report text");
      await submitRefinement(user, {
        lengthOption: selectedOption,
        instruction: instruction || undefined,
      });
      await waitFor(() =>
        expect((screen.getByLabelText("Final news report text") as HTMLTextAreaElement).value)
          .toBe(nextText),
      );

      expect(rewriteMock).toHaveBeenNthCalledWith(
        2,
        reviewedSource,
        highReview,
        [{ rewrittenText: firstText, lengthOption: null, instruction: "" }],
        { lengthOption: expectedOption, instruction },
      );
    },
  );

  it("preserves ordered versions and instructions across three rewrites while applying the latest preference", async () => {
    const reviewedSource = sourceFor("Conversation memory facts.");
    const versions = [
      "Version one headline\n\nVersion one report.",
      "Version two headline\n\nVersion two report.",
      "Version three headline\n\nVersion three report.",
    ];
    reviewMock.mockResolvedValue({
      ...reviewResponse(highReview, reviewedSource.primaryText),
      source: reviewedSource,
    });
    rewriteMock
      .mockResolvedValueOnce(rewriteResponse(versions[0]))
      .mockResolvedValueOnce(rewriteResponse(versions[1]))
      .mockResolvedValueOnce(rewriteResponse(versions[2]));
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    await submitReview(user, reviewedSource.primaryText);
    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));
    await screen.findByLabelText("Final news report text");
    await submitRefinement(user, {
      lengthOption: "concise",
      instruction: "Make the opening more engaging.",
    });
    await waitFor(() =>
      expect((screen.getByLabelText("Final news report text") as HTMLTextAreaElement).value)
        .toBe(versions[1]),
    );
    await submitRefinement(user, {
      lengthOption: "more_detailed",
      instruction: "Move the quotation to the second paragraph.",
    });
    await waitFor(() =>
      expect((screen.getByLabelText("Final news report text") as HTMLTextAreaElement).value)
        .toBe(versions[2]),
    );

    expect(rewriteMock).toHaveBeenNthCalledWith(
      3,
      reviewedSource,
      highReview,
      [
        { rewrittenText: versions[0], lengthOption: null, instruction: "" },
        {
          rewrittenText: versions[1],
          lengthOption: "concise",
          instruction: "Make the opening more engaging.",
        },
      ],
      {
        lengthOption: "more_detailed",
        instruction: "Move the quotation to the second paragraph.",
      },
    );
  });

  it("cancels refinement without rewriting and resets the optional controls", async () => {
    reviewMock.mockResolvedValue(reviewResponse(highReview, "Cancel refinement facts."));
    rewriteMock.mockResolvedValue(rewriteResponse("Current headline\n\nCurrent report."));
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    await submitReview(user, "Cancel refinement facts.");
    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));
    await screen.findByLabelText("Final news report text");
    await openRefinement(user);
    await user.click(screen.getByRole("button", { name: "Concise" }));
    await user.type(screen.getByLabelText(/Improvement instructions/u), "Discard this request.");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("heading", { name: "Refine the next rewrite" })).toBeNull();
    expect(screen.getByLabelText("Final news report text")).toBeTruthy();
    expect(rewriteMock).toHaveBeenCalledOnce();

    await openRefinement(user);
    expect(screen.getByRole("button", { name: "Concise" }).getAttribute("aria-pressed"))
      .toBe("false");
    expect((screen.getByLabelText(/Improvement instructions/u) as HTMLTextAreaElement).value)
      .toBe("");
  });

  it("starts a new article with empty rewrite history", async () => {
    const firstSource = sourceFor("First article facts.");
    const secondSource = sourceFor("Second article facts.");
    reviewMock
      .mockResolvedValueOnce({ ...reviewResponse(highReview, firstSource.primaryText), source: firstSource })
      .mockResolvedValueOnce({ ...reviewResponse(highReview, secondSource.primaryText), source: secondSource });
    rewriteMock
      .mockResolvedValueOnce(rewriteResponse("First article headline\n\nFirst article report."))
      .mockResolvedValueOnce(rewriteResponse("Second article headline\n\nSecond article report."));
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    await submitReview(user, firstSource.primaryText);
    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));
    await screen.findByLabelText("Final news report text");
    await waitFor(() => expect(window.sessionStorage.getItem(REWRITE_SESSION_STORAGE_KEY)).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "Start New Draft" }));
    expect((screen.getByRole("textbox", { name: /News draft/u }) as HTMLTextAreaElement).value)
      .toBe("");
    expect(window.sessionStorage.getItem(REWRITE_SESSION_STORAGE_KEY)).toBeNull();

    await submitReview(user, secondSource.primaryText);
    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));
    await screen.findByLabelText("Final news report text");
    expect(rewriteMock).toHaveBeenNthCalledWith(
      2,
      secondSource,
      highReview,
      [],
      { lengthOption: null, instruction: "" },
    );
  });

  it("restores the article and complete rewrite history after an unmount and remount", async () => {
    const reviewedSource = sourceFor("Restored article facts.");
    const firstText = "Restored version one\n\nFirst restored report.";
    const secondText = "Restored version two\n\nSecond restored report.";
    const thirdText = "Restored version three\n\nThird restored report.";
    reviewMock.mockResolvedValue({
      ...reviewResponse(highReview, reviewedSource.primaryText),
      source: reviewedSource,
    });
    rewriteMock
      .mockResolvedValueOnce(rewriteResponse(firstText))
      .mockResolvedValueOnce(rewriteResponse(secondText))
      .mockResolvedValueOnce(rewriteResponse(thirdText));
    const user = userEvent.setup();
    const firstRender = render(<PressReleaseWorkspace initialPassScore={80} />);

    await submitReview(user, reviewedSource.primaryText);
    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));
    await screen.findByLabelText("Final news report text");
    await submitRefinement(user, {
      lengthOption: "concise",
      instruction: "Keep the original opening instruction.",
    });
    await waitFor(() => {
      const stored = JSON.parse(
        window.sessionStorage.getItem(REWRITE_SESSION_STORAGE_KEY) ?? "null",
      ) as { history?: unknown[] } | null;
      expect(stored?.history).toHaveLength(2);
    });

    firstRender.unmount();
    render(<PressReleaseWorkspace initialPassScore={80} />);
    expect((await screen.findByRole("textbox", { name: /News draft/u }) as HTMLTextAreaElement).value)
      .toBe(reviewedSource.primaryText);
    expect((await screen.findByLabelText("Final news report text") as HTMLTextAreaElement).value)
      .toBe(secondText);

    await submitRefinement(user, { instruction: "Retain that instruction after refresh." });
    await waitFor(() =>
      expect((screen.getByLabelText("Final news report text") as HTMLTextAreaElement).value)
        .toBe(thirdText),
    );
    expect(rewriteMock).toHaveBeenNthCalledWith(
      3,
      reviewedSource,
      highReview,
      [
        { rewrittenText: firstText, lengthOption: null, instruction: "" },
        {
          rewrittenText: secondText,
          lengthOption: "concise",
          instruction: "Keep the original opening instruction.",
        },
      ],
      { lengthOption: null, instruction: "Retain that instruction after refresh." },
    );
  });

  it("marks a changed review stale but restores it when the exact input is restored", async () => {
    reviewMock.mockResolvedValue(reviewResponse(highReview, "Original version."));
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    const editor = screen.getByRole("textbox", { name: /News draft/u });
    await user.type(editor, "Original version.");
    await user.click(screen.getByRole("button", { name: "Review Draft" }));
    await screen.findByText("Score rationale");

    await user.type(editor, " Edited.");
    expect(await screen.findByText("Review applies to an earlier version")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Rewrite with AI" }) as HTMLButtonElement).disabled)
      .toBe(true);

    await user.clear(editor);
    await user.type(editor, "Original version.");
    expect(screen.queryByText("Review applies to an earlier version")).toBeNull();
    expect((screen.getByRole("button", { name: "Rewrite with AI" }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it("clears an older rewrite immediately and never restores it after a later failure", async () => {
    reviewMock.mockResolvedValue(reviewResponse(lowReview, "Draft preserved after failure."));
    const laterRewrite = deferred<RewriteApiResponse>();
    rewriteMock
      .mockResolvedValueOnce(rewriteResponse("First headline\n\nFirst body."))
      .mockReturnValueOnce(laterRewrite.promise);
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    await user.type(
      screen.getByRole("textbox", { name: /News draft/u }),
      "Draft preserved after failure.",
    );
    await user.click(screen.getByRole("button", { name: "Review Draft" }));
    await screen.findByText("Score rationale");
    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));
    await screen.findByLabelText("Final news report text");

    await user.click(screen.getByRole("button", { name: "Rewrite with AI Again" }));
    expect(screen.getByLabelText("Final news report text")).toBeTruthy();
    expect(rewriteMock).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Rewrite Again" }));
    expect(screen.queryByLabelText("Final news report text")).toBeNull();
    await act(async () => laterRewrite.reject(new ApiRequestError("DEEPSEEK_TIMEOUT", "Timed out.")));
    expect(await screen.findByText("Timed out.")).toBeTruthy();
    expect(screen.queryByLabelText("Final news report text")).toBeNull();
  });

  it("shows exact actionable quotation diagnostics, retained candidate, and retry", async () => {
    reviewMock.mockResolvedValue(reviewResponse(lowReview, "甲說：「原句。」"));
    rewriteMock.mockRejectedValue(
      new ApiRequestError(
        "INEXACT_REWRITE_QUOTATION",
        "Quotation preservation still failed.",
        {
          retryable: true,
          attempts: 2,
          candidateText: "標題\n\n甲說：「改句！」",
          quotationIssues: [
            {
              kind: "modified",
              original: "「原句。」",
              rewrite: "「改句！」",
              sourceParagraph: 1,
              rewriteParagraph: 2,
              sourceExcerpt: "甲說：「原句。」",
              differenceSummary: "Two characters and the closing punctuation changed.",
              action: "Restore the source quotation exactly and retry.",
            },
          ],
        },
      ),
    );
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    await user.type(screen.getByRole("textbox", { name: /News draft/u }), "甲說：「原句。」");
    await user.click(screen.getByRole("button", { name: "Review Draft" }));
    await screen.findByText("Score rationale");
    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));

    expect(await screen.findByText("Paragraph 1: Quoted wording was modified")).toBeTruthy();
    expect(screen.getByText("「原句。」")).toBeTruthy();
    expect(screen.getByText("「改句！」")).toBeTruthy();
    expect(screen.getByText("Two characters and the closing punctuation changed.")).toBeTruthy();
    expect((screen.getByLabelText(/Generated draft/u) as HTMLTextAreaElement).value)
      .toContain("改句");
    expect(screen.getByRole("button", { name: "Retry Rewrite" })).toBeTruthy();
    expect(screen.queryByLabelText("Final news report text")).toBeNull();
  });

  it("clears a failed quotation candidate on manual retry and displays only the latest response", async () => {
    const latestRewrite = deferred<RewriteApiResponse>();
    reviewMock.mockResolvedValue(reviewResponse(lowReview, "甲說：「原句。」"));
    rewriteMock
      .mockResolvedValueOnce(rewriteResponse("First headline\n\nFirst validated body."))
      .mockRejectedValueOnce(
        new ApiRequestError(
          "INEXACT_REWRITE_QUOTATION",
          "Quotation preservation still failed.",
          {
            retryable: true,
            attempts: 2,
            candidateText: "Failed headline\n\n甲說：「改句！」",
            quotationIssues: [
              {
                kind: "modified",
                original: "「原句。」",
                rewrite: "「改句！」",
                sourceParagraph: 1,
                rewriteParagraph: 2,
                sourceExcerpt: "甲說：「原句。」",
                differenceSummary: "Two characters and the closing punctuation changed.",
                action: "Restore the source quotation exactly and retry.",
              },
            ],
          },
        ),
      )
      .mockReturnValueOnce(latestRewrite.promise);
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    await user.type(screen.getByRole("textbox", { name: /News draft/u }), "甲說：「原句。」");
    await user.click(screen.getByRole("button", { name: "Review Draft" }));
    await screen.findByText("Score rationale");
    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));
    expect((await screen.findByLabelText("Final news report text") as HTMLTextAreaElement).value)
      .toBe("First headline\n\nFirst validated body.");

    await user.click(screen.getByRole("button", { name: "Rewrite with AI Again" }));
    expect(rewriteMock).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Rewrite Again" }));
    expect(await screen.findByText("Paragraph 1: Quoted wording was modified")).toBeTruthy();
    expect(screen.queryByLabelText("Final news report text")).toBeNull();
    expect((screen.getByLabelText(/Generated draft/u) as HTMLTextAreaElement).value)
      .toContain("改句");

    await user.click(screen.getByRole("button", { name: "Retry Rewrite" }));
    expect(screen.queryByLabelText(/Generated draft/u)).toBeNull();
    expect(screen.queryByLabelText("Final news report text")).toBeNull();
    expect(screen.getByText("Rewrite in progress")).toBeTruthy();

    await act(async () =>
      latestRewrite.resolve(rewriteResponse("Latest headline\n\nLatest validated body.")),
    );
    expect((await screen.findByLabelText("Final news report text") as HTMLTextAreaElement).value)
      .toBe("Latest headline\n\nLatest validated body.");
    expect(screen.queryByText("Paragraph 1: Quoted wording was modified")).toBeNull();
    expect(rewriteMock).toHaveBeenCalledTimes(3);
  });

  it("prevents duplicate review and rewrite submissions while either agent is running", async () => {
    const pendingReview = deferred<ReviewApiResponse>();
    const pendingRewrite = deferred<RewriteApiResponse>();
    reviewMock.mockReturnValue(pendingReview.promise);
    rewriteMock.mockReturnValue(pendingRewrite.promise);
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    const editor = screen.getByRole("textbox", { name: /News draft/u });
    await user.type(editor, "One request at a time.");
    await user.dblClick(screen.getByRole("button", { name: "Review Draft" }));
    expect(reviewMock).toHaveBeenCalledOnce();

    await act(async () => pendingReview.resolve(reviewResponse(highReview, "One request at a time.")));
    await screen.findByText("Score rationale");
    await user.dblClick(screen.getByRole("button", { name: "Rewrite with AI" }));
    expect(rewriteMock).toHaveBeenCalledOnce();

    await act(async () =>
      pendingRewrite.resolve(rewriteResponse("Single rewrite\n\nOnly one request ran.")),
    );
    expect((await screen.findByLabelText("Final news report text") as HTMLTextAreaElement).value)
      .toBe("Single rewrite\n\nOnly one request ran.");
    await waitFor(() => expect((editor as HTMLTextAreaElement).disabled).toBe(false));
  });

  it("keeps long maximum-reasoning work visibly active with an elapsed timer", async () => {
    vi.useFakeTimers();
    const pendingReview = deferred<ReviewApiResponse>();
    reviewMock.mockReturnValue(pendingReview.promise);
    render(<PressReleaseWorkspace initialPassScore={80} />);

    fireEvent.change(screen.getByRole("textbox", { name: /News draft/u }), {
      target: { value: "A long review request." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review Draft" }));
    expect(screen.getByText("Review in progress")).toBeTruthy();
    expect(screen.getByText("Elapsed: 0s")).toBeTruthy();

    await act(async () => vi.advanceTimersByTime(31_000));
    expect(screen.getByText(/maximum reasoning effort/u)).toBeTruthy();
    expect(screen.getByText("Elapsed: 31s")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Reviewing Draft/u }) as HTMLButtonElement).disabled)
      .toBe(true);

    await act(async () => {
      pendingReview.resolve(reviewResponse(highReview, "A long review request."));
      await Promise.resolve();
    });
    expect(screen.getByText("Score rationale")).toBeTruthy();
    expect(screen.queryByText("Review in progress")).toBeNull();
  });

  it("shows safe stage, provider, model, HTTP status, and cause diagnostics", async () => {
    reviewMock.mockRejectedValue(
      new ApiRequestError(
        "DEEPSEEK_MODEL_ERROR",
        "DeepSeek rejected the configured model.",
        {
          retryable: false,
          stage: "review_request",
          provider: "DeepSeek",
          model: "invalid-model-diagnostic",
          httpStatus: 400,
          causeSummary:
            "DeepSeek rejected configured model invalid-model-diagnostic. Supported model IDs are deepseek-v4-pro and deepseek-v4-flash.",
        },
      ),
    );
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    await user.type(screen.getByRole("textbox", { name: /News draft/u }), "Trigger safe diagnostics.");
    await user.click(screen.getByRole("button", { name: "Review Draft" }));

    expect(await screen.findByText("Review Agent request")).toBeTruthy();
    expect(screen.getByText("DeepSeek")).toBeTruthy();
    expect(screen.getAllByText("invalid-model-diagnostic").length).toBeGreaterThan(0);
    expect(screen.getByText("400")).toBeTruthy();
    expect(screen.getByText(/Supported model IDs/u)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Authorization");
    expect(document.body.textContent).not.toContain("PRIVATE_REASONING_MARKER");
  });
});
