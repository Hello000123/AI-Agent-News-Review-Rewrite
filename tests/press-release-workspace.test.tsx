// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PressReleaseWorkspace } from "@/components/press-release-workspace";
import {
  ApiRequestError,
  requestDirectRewrite,
  requestReview,
  requestRewrite,
} from "@/lib/client/api";
import { requestFileExtraction } from "@/lib/client/file-api";
import { REWRITE_SESSION_STORAGE_KEY } from "@/lib/client/rewrite-session";
import type {
  ReviewApiResponse,
  DirectRewriteApiResponse,
  RewriteApiResponse,
  RewriteLengthOption,
  SourceSnapshot,
} from "@/lib/shared/contracts";
import { highReview, lowReview } from "@/tests/fixtures/reviews";

vi.mock("@/lib/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client/api")>();
  return {
    ...actual,
    requestDirectRewrite: vi.fn(),
    requestReview: vi.fn(),
    requestRewrite: vi.fn(),
  };
});

vi.mock("@/lib/client/file-api", () => ({
  requestFileExtraction: vi.fn(),
}));

const reviewMock = vi.mocked(requestReview);
const directRewriteMock = vi.mocked(requestDirectRewrite);
const rewriteMock = vi.mocked(requestRewrite);
const fileExtractionMock = vi.mocked(requestFileExtraction);

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

function directRewriteResponse(
  finalText: string,
  source: SourceSnapshot,
): DirectRewriteApiResponse {
  return { ...rewriteResponse(finalText), source };
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

  it("asks before appending or replacing extracted content and never loses existing text", async () => {
    fileExtractionMock.mockResolvedValue({
      file: {
        name: "briefing.docx",
        type: "Microsoft Word",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 1_024,
        status: "ready",
      },
      content: "First extracted paragraph.\nSecond extracted paragraph.",
      truncated: false,
    });
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);
    const editor = screen.getByRole("textbox", { name: /News draft/u });
    await user.type(editor, "Existing draft text.");

    const file = new File(["valid"], "briefing.docx", {
      type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await user.upload(document.querySelector("#draft-file") as HTMLInputElement, file);

    expect(await screen.findByText("Keep the current draft?")).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe("Existing draft text.");
    await user.click(screen.getByRole("button", { name: "Append to draft" }));
    expect((editor as HTMLTextAreaElement).value).toBe(
      "Existing draft text.\n\nFirst extracted paragraph.\nSecond extracted paragraph.",
    );
  });

  it("rejects an unsupported Draft attachment before sending it", async () => {
    render(<PressReleaseWorkspace initialPassScore={80} />);
    const file = new File(["plain"], "notes.txt", { type: "text/plain" });
    fireEvent.change(document.querySelector("#draft-file") as HTMLInputElement, {
      target: { files: [file] },
    });

    expect(
      await screen.findByText(/Unsupported file format/u),
    ).toBeTruthy();
    expect(fileExtractionMock).not.toHaveBeenCalled();
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
      model: "grok-4.5",
    });
    expect(rewriteMock).not.toHaveBeenCalled();
  });

  it("goes straight from Source Input to a rewrite and refines without review feedback", async () => {
    const source = sourceFor("Direct rewrite facts.");
    const firstText = "Direct headline\n\nDirect rewritten report.";
    const secondText = "Refined direct headline\n\nRefined direct rewritten report.";
    directRewriteMock.mockResolvedValue(directRewriteResponse(firstText, source));
    rewriteMock.mockResolvedValue(rewriteResponse(secondText));
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    await user.type(screen.getByRole("textbox", { name: /News draft/u }), source.primaryText);
    await user.click(screen.getByRole("button", { name: "Rewrite Draft" }));

    expect((await screen.findByLabelText("Final news report text") as HTMLTextAreaElement).value)
      .toBe(firstText);
    expect(reviewMock).not.toHaveBeenCalled();
    expect(directRewriteMock).toHaveBeenCalledWith({
      draft: source.primaryText,
      sourceUrl: "",
      model: "grok-4.5",
    });
    expect(screen.queryByText("Score rationale")).toBeNull();

    await openRefinement(user);
    await user.type(screen.getByLabelText(/Improvement instructions/u), "Tighten the lead.");
    await user.click(screen.getByRole("button", { name: "Rewrite Again" }));
    expect((await screen.findByLabelText("Final news report text") as HTMLTextAreaElement).value)
      .toBe(secondText);
    expect(rewriteMock).toHaveBeenCalledWith(
      source,
      null,
      [{ rewrittenText: firstText, lengthOption: null, instruction: "" }],
      { lengthOption: null, instruction: "Tighten the lead." },
      "grok-4.5",
    );
  });

  it("sends the URL while exposing the new document attachment input", async () => {
    reviewMock.mockResolvedValue(reviewResponse(highReview, "Retrieved article text."));
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    expect(screen.queryByLabelText("Supporting images (optional)")).toBeNull();
    expect(screen.queryByLabelText("Image captions or OCR text")).toBeNull();
    expect(screen.queryByLabelText("Output language")).toBeNull();
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
    expect(fileInput?.getAttribute("accept")).toContain(".pdf");
    expect(fileInput?.getAttribute("accept")).toContain(".xlsx");

    await user.type(screen.getByLabelText("Public article URL"), "https://example.com/article");
    await user.click(screen.getByRole("button", { name: "Review Draft" }));

    await screen.findByText("Score rationale");
    expect(reviewMock).toHaveBeenCalledWith({
      draft: "",
      sourceUrl: "https://example.com/article",
      model: "grok-4.5",
    });
  });

  it("changes the model for review and rewrite, marks older feedback stale, and persists it", async () => {
    const reviewedSource = sourceFor("Model selection facts.");
    reviewMock.mockResolvedValue({
      ...reviewResponse(highReview, reviewedSource.primaryText),
      source: reviewedSource,
    });
    rewriteMock.mockResolvedValue(
      rewriteResponse("Selected model headline\n\nSelected model report."),
    );
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} initialModel="grok-4.5" />);

    await submitReview(user, reviewedSource.primaryText);
    await user.click(
      screen.getByRole("button", {
        name: "Change AI model. Current model: Grok 4.5",
      }),
    );
    expect(screen.getByRole("group", { name: "Choose the AI model" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Grok 4.3/u })).toBeNull();
    await user.click(screen.getByRole("radio", { name: /DeepSeek V4 Pro/u }));

    expect(
      screen.getByRole("button", {
        name: "Change AI model. Current model: DeepSeek V4 Pro",
      }),
    ).toBeTruthy();
    expect(await screen.findByText("Review applies to an earlier version")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Rewrite with AI" }) as HTMLButtonElement).disabled)
      .toBe(true);

    await user.click(screen.getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("button", { name: "Review Draft" }));
    await waitFor(() => expect(reviewMock).toHaveBeenCalledTimes(2));
    expect(reviewMock).toHaveBeenNthCalledWith(2, {
      draft: reviewedSource.primaryText,
      sourceUrl: "",
      model: "deepseek-v4-pro",
    });

    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));
    await screen.findByLabelText("Final news report text");
    expect(rewriteMock).toHaveBeenCalledWith(
      reviewedSource,
      highReview,
      [],
      { lengthOption: null, instruction: "" },
      "deepseek-v4-pro",
    );
    await waitFor(() => {
      const stored = JSON.parse(
        window.sessionStorage.getItem(REWRITE_SESSION_STORAGE_KEY) ?? "null",
      ) as { model?: string } | null;
      expect(stored?.model).toBe("deepseek-v4-pro");
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
      "grok-4.5",
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
      "grok-4.5",
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
        "grok-4.5",
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
      "grok-4.5",
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
      "grok-4.5",
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
      "grok-4.5",
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
    await act(async () => laterRewrite.reject(new ApiRequestError("XAI_TIMEOUT", "Timed out.")));
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

  it("keeps long high-reasoning work visibly active with an elapsed timer", async () => {
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
    expect(screen.getByText(/high reasoning effort/u)).toBeTruthy();
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
        "XAI_MODEL_ERROR",
        "xAI could not access the selected Grok model.",
        {
          retryable: false,
          stage: "review_request",
          provider: "xAI",
          model: "invalid-model-diagnostic",
          httpStatus: 404,
          causeSummary:
            "xAI could not find selected model invalid-model-diagnostic. Verify that this API key can access invalid-model-diagnostic.",
        },
      ),
    );
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    await user.type(screen.getByRole("textbox", { name: /News draft/u }), "Trigger safe diagnostics.");
    await user.click(screen.getByRole("button", { name: "Review Draft" }));

    expect(await screen.findByText("Review Agent request")).toBeTruthy();
    expect(screen.getByText("xAI")).toBeTruthy();
    expect(screen.getAllByText("invalid-model-diagnostic").length).toBeGreaterThan(0);
    expect(screen.getByText("404")).toBeTruthy();
    expect(screen.getByText(/access invalid-model-diagnostic/u)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Authorization");
    expect(document.body.textContent).not.toContain("PRIVATE_REASONING_MARKER");
  });
});
