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

  it("does not show help when the window returns focus to the last control", () => {
    render(
      <>
        <button type="button" title="Open Settings">
          icon
        </button>
        <button type="button" title="Search">
          icon
        </button>
        <TooltipLayer />
      </>,
    );
    const [settings, search] = screen.getAllByRole("button");

    fireEvent.focusIn(settings);
    fireEvent.blur(window);
    expect(screen.queryByRole("tooltip")).toBeNull();
    // Switching back to the app restores focus without any key or pointer input.
    fireEvent.focus(window);
    fireEvent.focusIn(settings);
    expect(screen.queryByRole("tooltip")).toBeNull();

    // The next focus the user moves still shows help.
    fireEvent.keyDown(document, { key: "Tab" });
    fireEvent.focusIn(search);
    expect(screen.getByRole("tooltip").textContent).toBe("Search");
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

  it("keeps help off a trigger while the menu or panel it opened is showing", async () => {
    const view = render(
      <>
        <button title="Readings for Example host" aria-expanded={false}>
          Live
        </button>
        <TooltipLayer />
      </>,
    );
    const trigger = screen.getByRole("button");
    fireEvent.focusIn(trigger);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    view.rerender(
      <>
        <button title="Readings for Example host" aria-expanded>
          Live
        </button>
        <TooltipLayer />
      </>,
    );
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(trigger.title).toBe("Readings for Example host");
    fireEvent.focusIn(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
    view.rerender(
      <>
        <button title="Readings for Example host" aria-expanded={false}>
          Live
        </button>
        <TooltipLayer />
      </>,
    );
    fireEvent.focusOut(trigger);
    fireEvent.focusIn(trigger);
    expect(screen.getByRole("tooltip").textContent).toBe("Readings for Example host");
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
