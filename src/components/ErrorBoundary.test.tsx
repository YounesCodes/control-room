// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./WindowControls", () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

import { ErrorBoundary } from "./ErrorBoundary";

function Bomb(): never {
  throw new Error("settings pane exploded");
}

describe("ErrorBoundary", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders its children while they are healthy", () => {
    render(
      <ErrorBoundary>
        <p>all fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("all fine")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("replaces a failed render with a readable message instead of a blank window", () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Something went wrong");
    // The message has to be on the screen, not only in the console: this view
    // is what the user sees when devtools are closed.
    expect(alert.textContent).toContain("settings pane exploded");
    // A crash says nothing about stored data, and must not claim it was lost.
    expect(alert.textContent).toContain("were not changed");
    expect(screen.getByRole("button", { name: /Reload/ })).toBeTruthy();
    expect(screen.getByTestId("window-controls")).toBeTruthy();
    expect(document.querySelector("[data-tauri-drag-region]")).toBeTruthy();
  });

  it("offers a reload that restarts the window", async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    render(
      <ErrorBoundary onReload={reload}>
        <Bomb />
      </ErrorBoundary>,
    );
    await user.click(screen.getByRole("button", { name: /Reload/ }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
