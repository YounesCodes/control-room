// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  resized: undefined as (() => void) | undefined,
  maximized: false,
  fullscreen: false,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    tauri.listeners.set(name, handler);
    return () => tauri.listeners.delete(name);
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => tauri.maximized,
    isFullscreen: async () => tauri.fullscreen,
    onResized: async (handler: () => void) => {
      tauri.resized = handler;
      return () => (tauri.resized = undefined);
    },
  }),
}));

import {
  COMPOSITING_CHANGED,
  roundedWindowCorners,
  useRoundedWindowCorners,
} from "./window-corners";

const corners = () => document.documentElement.dataset.windowCorners;

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.listeners.clear();
  tauri.resized = undefined;
  tauri.maximized = false;
  tauri.fullscreen = false;
});
afterEach(() => delete document.documentElement.dataset.windowCorners);

it("rounds only a composited window that does not fill the screen", () => {
  const base = { composited: true, maximized: false, fullscreen: false };
  expect(roundedWindowCorners(base)).toBe(true);
  expect(roundedWindowCorners({ ...base, composited: false })).toBe(false);
  expect(roundedWindowCorners({ ...base, maximized: true })).toBe(false);
  expect(roundedWindowCorners({ ...base, fullscreen: true })).toBe(false);
});

it("follows maximize and the compositor on Linux, and clears on unmount", async () => {
  tauri.invoke.mockResolvedValue(true);
  const { unmount } = renderHook(() => useRoundedWindowCorners());
  await waitFor(() => expect(corners()).toBe("rounded"));
  expect(tauri.invoke).toHaveBeenCalledWith("window_compositing");

  tauri.maximized = true;
  tauri.resized?.();
  await waitFor(() => expect(corners()).toBeUndefined());
  tauri.maximized = false;
  tauri.resized?.();
  await waitFor(() => expect(corners()).toBe("rounded"));

  tauri.listeners.get(COMPOSITING_CHANGED)?.({ payload: false });
  expect(corners()).toBeUndefined();
  tauri.listeners.get(COMPOSITING_CHANGED)?.({ payload: true });
  expect(corners()).toBe("rounded");

  unmount();
  expect(corners()).toBeUndefined();
  await waitFor(() => expect(tauri.resized).toBeUndefined());
  expect(tauri.listeners.size).toBe(0);
});

it("keeps the native frame where the compositor command does not exist", async () => {
  tauri.invoke.mockRejectedValue(new Error("Command window_compositing not found"));
  renderHook(() => useRoundedWindowCorners());
  await waitFor(() => expect(tauri.invoke).toHaveBeenCalled());
  await Promise.resolve();
  expect(corners()).toBeUndefined();
  expect(tauri.resized).toBeUndefined();
});
