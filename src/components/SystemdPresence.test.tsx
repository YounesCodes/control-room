// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SystemdPresence } from "./SystemdPresence";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("retains exiting content without exposing controls and cancels exit on reopening", () => {
  vi.useFakeTimers();
  const content = <button>Details action</button>;
  const view = render(<SystemdPresence open>{content}</SystemdPresence>);
  view.rerender(<SystemdPresence open={false}>{null}</SystemdPresence>);
  expect(screen.queryByRole("button")).toBeNull();
  expect(view.container.querySelector("[data-leaving][inert] button")?.textContent).toBe(
    "Details action",
  );
  act(() => vi.advanceTimersByTime(90));
  view.rerender(<SystemdPresence open>{content}</SystemdPresence>);
  act(() => vi.advanceTimersByTime(180));
  expect(screen.getByRole("button")).toBeTruthy();
  view.rerender(<SystemdPresence open={false}>{null}</SystemdPresence>);
  act(() => vi.advanceTimersByTime(180));
  expect(view.container.childElementCount).toBe(0);
});
