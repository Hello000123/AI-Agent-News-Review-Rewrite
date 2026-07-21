// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import Home from "@/app/page";

describe("home page chrome", () => {
  afterEach(cleanup);

  it("omits the former branded header while keeping the main workspace", () => {
    render(<Home />);

    expect(document.querySelector("header")).toBeNull();
    expect(screen.queryByLabelText("PressReady home")).toBeNull();
    expect(screen.queryByText("Facts preserved")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: /From rough draft to/u })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Add the article or draft" })).toBeTruthy();
  });
});
