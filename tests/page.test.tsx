// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReviewWorkspacePage } from "@/app/page";

describe("home page chrome", () => {
  afterEach(cleanup);

  it("shows authenticated account navigation and keeps the main workspace", () => {
    render(
      <ReviewWorkspacePage
        user={{
          id: "user-1",
          email: "client@example.test",
          fullName: "Client Editor",
          role: "client",
        }}
        passScore={80}
        initialModel="grok-4.5"
      />,
    );

    expect(document.querySelector("header")).not.toBeNull();
    expect(screen.getByText("client@example.test")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Logout" })).toBeTruthy();
    expect(screen.queryByText("Facts preserved")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: /From rough draft to/u })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Add the article or draft" })).toBeTruthy();
  });
});
