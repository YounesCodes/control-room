// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalWorkspace } from "../types";

const transition = vi.hoisted(() => ({
  transitionFocusMode: vi.fn((_direction: "enter" | "exit", update: () => void) => update()),
}));
vi.mock("../lib/focus-mode-transition", () => transition);

import { useWorkspaceSession } from "./use-workspace-session";
import { closeWorkspaceInSession } from "../lib/workspace-session";

function local(id: string): LocalWorkspace {
  return {
    kind: "local",
    id,
    label: null,
    shell: { id: "pwsh", label: "PowerShell", kind: "powershell-7", elevated: false },
    sessionId: null,
    state: "connected",
    reason: null,
    view: "terminal",
    reconnectToken: 0,
    connectRequested: true,
  };
}

function renderSession() {
  const focusModeChanged = vi.fn();
  const rendered = renderHook(() => useWorkspaceSession(focusModeChanged));
  const controls = () => rendered.result.current[1];
  const state = () => rendered.result.current[0];
  return { focusModeChanged, controls, state };
}

afterEach(() => {
  cleanup();
  transition.transitionFocusMode.mockClear();
});

describe("useWorkspaceSession", () => {
  it("applies changes made in the same tick to the state the previous change left", () => {
    const { controls, state } = renderSession();
    act(() => {
      controls().restore({
        workspaces: [local("a"), local("b"), local("c")],
        activeWorkspaceId: "a",
        terminalGroups: [],
        terminalFocusMode: false,
      });
    });
    act(() => {
      controls().commit((current) => closeWorkspaceInSession(current, "a"));
      controls().commit((current) => closeWorkspaceInSession(current, "b"));
    });
    expect(state().workspaces.map((workspace) => workspace.id)).toEqual(["c"]);
    expect(controls().current()).toBe(state());
  });

  it("reads the latest committed state before React renders it", () => {
    const { controls } = renderSession();
    act(() => {
      controls().setWorkspaces(() => [local("a")]);
      expect(
        controls()
          .current()
          .workspaces.map((workspace) => workspace.id),
      ).toEqual(["a"]);
    });
  });

  it("changes Focus Mode only inside the focus transition", () => {
    const { controls, state, focusModeChanged } = renderSession();
    act(() => {
      controls().setWorkspaces(() => [local("a")]);
      controls().setActiveWorkspaceId("a");
    });
    expect(transition.transitionFocusMode).not.toHaveBeenCalled();

    act(() => controls().setTerminalFocusMode(true));
    expect(transition.transitionFocusMode).toHaveBeenLastCalledWith("enter", expect.any(Function));
    expect(state().terminalFocusMode).toBe(true);

    act(() => controls().setTerminalFocusMode(true));
    expect(transition.transitionFocusMode).toHaveBeenCalledTimes(1);

    act(() => controls().commit((current) => closeWorkspaceInSession(current, "a")));
    expect(transition.transitionFocusMode).toHaveBeenLastCalledWith("exit", expect.any(Function));
    expect(state().terminalFocusMode).toBe(false);
    expect(focusModeChanged).toHaveBeenCalledTimes(2);
  });

  it("does not enter Focus Mode without an active Workspace", () => {
    const { controls, state } = renderSession();
    act(() => controls().setTerminalFocusMode(true));
    expect(state().terminalFocusMode).toBe(false);
    expect(transition.transitionFocusMode).not.toHaveBeenCalled();
  });

  it("restores a saved Focus Mode without animating it", () => {
    const { controls, state } = renderSession();
    act(() =>
      controls().restore({
        workspaces: [local("a")],
        activeWorkspaceId: "a",
        terminalGroups: [],
        terminalFocusMode: true,
      }),
    );
    expect(state().terminalFocusMode).toBe(true);
    expect(transition.transitionFocusMode).not.toHaveBeenCalled();
  });

  it("keeps the same state when a change returns what it was given", () => {
    const { controls, state } = renderSession();
    const before = state();
    act(() => {
      controls().setWorkspaces((current) => current);
      controls().setTerminalGroups((current) => current);
      controls().setActiveWorkspaceId(null);
    });
    expect(state()).toBe(before);
  });
});
