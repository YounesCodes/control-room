// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});
