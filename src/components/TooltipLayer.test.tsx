// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipLayer } from "./TooltipLayer";

afterEach(cleanup);

describe("TooltipLayer", () => {
  it("shows title help on keyboard focus and restores the fallback on blur", () => {
    render(
      <>
        <button type="button" aria-label="Rename" title="Rename Workspace">
          icon
        </button>
        <button type="button">Next</button>
        <TooltipLayer />
      </>,
    );
    const target = screen.getByRole("button", { name: "Rename" });

    fireEvent.focusIn(target);
    expect(screen.getByRole("tooltip").textContent).toBe("Rename Workspace");
    expect(target.hasAttribute("title")).toBe(false);

    fireEvent.focusOut(target, { relatedTarget: screen.getByRole("button", { name: "Next" }) });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(target.title).toBe("Rename Workspace");
  });

  it("dismisses stale help when a renamed target changes its title without restoring the old name", async () => {
    const view = render(
      <>
        <button title="Old name">Target</button>
        <TooltipLayer />
      </>,
    );
    const target = screen.getByRole("button");
    fireEvent.focusIn(target);
    view.rerender(
      <>
        <button title="New name">Target</button>
        <TooltipLayer />
      </>,
    );
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(target.title).toBe("New name");
    fireEvent.focusIn(target);
    expect(screen.getByRole("tooltip").textContent).toBe("New name");
  });

  it("dismisses help when its terminal tab is removed", async () => {
    const view = render(
      <>
        <button title="Terminal">Target</button>
        <TooltipLayer />
      </>,
    );
    fireEvent.focusIn(screen.getByRole("button"));
    expect(screen.getByRole("tooltip")).toBeTruthy();
    view.rerender(<TooltipLayer />);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("cancels a pending hover when the terminal is removed", async () => {
    const view = render(
      <>
        <button title="Terminal">Target</button>
        <TooltipLayer />
      </>,
    );
    fireEvent.pointerOver(screen.getByRole("button"));
    view.rerender(<TooltipLayer />);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
