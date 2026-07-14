// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PressReleaseWorkspace } from "@/components/press-release-workspace";
import {
  ApiRequestError,
  requestReview,
  requestRewrite,
} from "@/lib/client/api";
import type { ReviewApiResponse, RewriteApiResponse } from "@/lib/shared/contracts";
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

function reviewResponse(review = highReview): ReviewApiResponse {
  return {
    review,
    passScore: 80,
    message: "Review complete. Choose how to continue.",
  };
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

describe("score-first workspace", () => {
  beforeEach(() => {
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
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["passing", highReview],
    ["failing", lowReview],
  ])(
    "renders the complete %s review and both actions without final output",
    async (_label, review) => {
      reviewMock.mockResolvedValue(reviewResponse(review));
      const user = userEvent.setup();
      render(<PressReleaseWorkspace initialPassScore={80} />);

      const editor = screen.getByRole("textbox", { name: /News draft/u });
      await user.type(editor, "Original supported facts.");
      await user.click(screen.getByRole("button", { name: "Review Draft" }));

      expect(await screen.findByText("Score rationale")).toBeTruthy();
      expect(screen.getByLabelText(`${Math.round(review.overallScore)} out of 100`)).toBeTruthy();
      expect(screen.getByText(review.scoreReasons.content, { exact: false })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Rewrite with AI" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Edit draft myself" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "AI-rewritten news report" })).toBeNull();
      expect(reviewMock).toHaveBeenCalledOnce();
      expect(reviewMock).toHaveBeenCalledWith("Original supported facts.");
      expect(rewriteMock).not.toHaveBeenCalled();
    },
  );

  it("makes one separate rewrite call with the immutable reviewed draft and matching review", async () => {
    reviewMock.mockResolvedValue(reviewResponse(highReview));
    rewriteMock.mockResolvedValue({
      finalText: "Accurate headline\n\nA publication-quality news report.",
    });
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    const editor = screen.getByRole("textbox", { name: /News draft/u });
    await user.type(editor, "Immutable reviewed facts.");
    await user.click(screen.getByRole("button", { name: "Review Draft" }));
    await screen.findByText("Score rationale");
    expect(screen.queryByLabelText("Final news report text")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));

    expect(
      (await screen.findByLabelText("Final news report text") as HTMLTextAreaElement).value,
    ).toBe("Accurate headline\n\nA publication-quality news report.");
    expect(rewriteMock).toHaveBeenCalledOnce();
    expect(rewriteMock).toHaveBeenCalledWith("Immutable reviewed facts.", highReview);
  });

  it("focuses the editor without an AI call and keeps a sticky stale review after editing", async () => {
    reviewMock.mockResolvedValue(reviewResponse(highReview));
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    const editor = screen.getByRole("textbox", { name: /News draft/u });
    await user.type(editor, "Original version.");
    await user.click(screen.getByRole("button", { name: "Review Draft" }));
    await screen.findByText("Score rationale");

    await user.click(screen.getByRole("button", { name: "Edit draft myself" }));
    expect(document.activeElement).toBe(editor);
    expect(reviewMock).toHaveBeenCalledOnce();
    expect(rewriteMock).not.toHaveBeenCalled();
    expect(screen.getByText("Score rationale")).toBeTruthy();

    await user.type(editor, " Edited.");
    expect(await screen.findByText("Review applies to an earlier version")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Rewrite with AI" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Edit draft myself" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    await user.clear(editor);
    await user.type(editor, "Original version.");
    expect(screen.getByText("Review applies to an earlier version")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Rewrite with AI" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(rewriteMock).not.toHaveBeenCalled();
  });

  it("preserves the draft, review, feedback, and both actions after a rewrite error", async () => {
    reviewMock.mockResolvedValue(reviewResponse(lowReview));
    rewriteMock
      .mockRejectedValueOnce(new ApiRequestError("DEEPSEEK_TIMEOUT", "The rewrite timed out."))
      .mockResolvedValueOnce({ finalText: "Retry headline\n\nRetry body." });
    const user = userEvent.setup();
    render(<PressReleaseWorkspace initialPassScore={80} />);

    const editor = screen.getByRole("textbox", { name: /News draft/u });
    await user.type(editor, "Draft preserved after failure.");
    await user.click(screen.getByRole("button", { name: "Review Draft" }));
    await screen.findByText("Score rationale");
    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));

    expect(await screen.findByText("The rewrite timed out.")).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe("Draft preserved after failure.");
    expect(screen.getByText(lowReview.scoreReasons.content, { exact: false })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Rewrite with AI" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Edit draft myself" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByLabelText("Final news report text")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Rewrite with AI" }));
    expect(
      (await screen.findByLabelText("Final news report text") as HTMLTextAreaElement).value,
    ).toBe("Retry headline\n\nRetry body.");
    expect(rewriteMock).toHaveBeenCalledTimes(2);
    expect(rewriteMock).toHaveBeenNthCalledWith(1, "Draft preserved after failure.", lowReview);
    expect(rewriteMock).toHaveBeenNthCalledWith(2, "Draft preserved after failure.", lowReview);
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
    expect((editor as HTMLTextAreaElement).disabled).toBe(true);

    await act(async () => pendingReview.resolve(reviewResponse(highReview)));
    await screen.findByText("Score rationale");

    await user.dblClick(screen.getByRole("button", { name: "Rewrite with AI" }));
    expect(rewriteMock).toHaveBeenCalledOnce();
    expect(
      (screen.getByRole("button", { name: "Edit draft myself" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () =>
      pendingRewrite.resolve({ finalText: "Single rewrite\n\nOnly one request ran." }),
    );
    expect(
      (await screen.findByLabelText("Final news report text") as HTMLTextAreaElement).value,
    ).toBe("Single rewrite\n\nOnly one request ran.");
    await waitFor(() => expect((editor as HTMLTextAreaElement).disabled).toBe(false));
  });
});
