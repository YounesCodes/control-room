// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegisteredAction } from "../lib/action-registry";
import { CommandPalette } from "./CommandPalette";

function Harness({ actions }: { actions: RegisteredAction[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      {open && <CommandPalette actions={actions} onClose={() => setOpen(false)} />}
    </>
  );
}

function action(
  id: string,
  label: string,
  run: () => void,
  patch: Partial<RegisteredAction> = {},
): RegisteredAction {
  return {
    id,
    scope: "global",
    group: "Actions",
    label,
    run,
    ...patch,
  };
}

describe("CommandPalette", () => {
  afterEach(cleanup);

  it("searches registered actions, executes with Enter, and restores focus", async () => {
    const user = userEvent.setup();
    const copy = vi.fn();
    render(
      <Harness
        actions={[
          action("systemd.copy-name", "Copy unit name", copy, {
            scope: "selection",
            group: "Selected unit",
            sublabel: "nginx.service",
          }),
          action("app.open-settings", "Open settings", vi.fn()),
        ]}
      />,
    );

    const launcher = screen.getByRole("button", { name: "Open palette" });
    await user.click(launcher);
    const search = screen.getByRole("combobox", { name: "Search commands" });
    expect(document.activeElement).toBe(search);
    await user.type(search, "nginx");
    expect(screen.getByRole("option", { name: /Copy unit name/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Open settings/ })).toBeNull();
    await user.keyboard("{Enter}");

    expect(copy).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    expect(document.activeElement).toBe(launcher);
  });

  it("keeps disabled actions inert and exposes their reason", async () => {
    const user = userEvent.setup();
    const disabled = vi.fn();
    const enabled = vi.fn();
    render(
      <Harness
        actions={[
          action("workspace.reconnect", "Reconnect terminal", disabled, {
            scope: "workspace",
            group: "Workspace",
            disabledReason: "A connection attempt is already running",
          }),
          action("workspace.close", "Close workspace", enabled, {
            scope: "workspace",
            group: "Workspace",
          }),
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open palette" }));
    expect(
      screen.getByRole("option", { name: /Reconnect terminal/ }).getAttribute("aria-disabled"),
    ).toBe("true");
    await user.keyboard("{Enter}");
    expect(disabled).not.toHaveBeenCalled();
    expect(screen.getByText("A connection attempt is already running")).toBeTruthy();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(enabled).toHaveBeenCalledOnce();
  });
});
