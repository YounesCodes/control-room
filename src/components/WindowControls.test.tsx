// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowControls } from "./WindowControls";

describe("WindowControls", () => {
  afterEach(cleanup);

  it("keeps the existing custom controls on Windows", async () => {
    const user = userEvent.setup();
    const actions = {
      close: vi.fn(async () => undefined),
      minimize: vi.fn(async () => undefined),
      toggleMaximize: vi.fn(async () => undefined),
    };
    render(<WindowControls platform="windows" windowActions={actions} />);

    await user.click(screen.getByRole("button", { name: "Minimize window" }));
    await user.click(screen.getByRole("button", { name: "Maximize or restore window" }));
    await user.click(screen.getByRole("button", { name: "Close window" }));

    expect(actions.minimize).toHaveBeenCalledOnce();
    expect(actions.toggleMaximize).toHaveBeenCalledOnce();
    expect(actions.close).toHaveBeenCalledOnce();
  });

  it("leaves window chrome to native macOS traffic lights", () => {
    const { container } = render(<WindowControls platform="macos" />);
    expect(container.childElementCount).toBe(0);
    expect(screen.queryByLabelText("Window controls")).toBeNull();
  });
});
