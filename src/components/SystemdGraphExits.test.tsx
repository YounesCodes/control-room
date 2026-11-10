// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SystemdGraphExits } from "./SystemdGraphExits";
import { layoutSystemdGraph } from "../lib/systemd-graph-layout";
import { systemdEdges } from "../lib/systemd-units";
import { systemdInspection } from "../test/systemd-fixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const edges = systemdEdges([systemdInspection("a.service", { Requires: "b.service" })]);
const full = layoutSystemdGraph(["a.service", "b.service"], edges, "a.service");
const small = layoutSystemdGraph(["a.service"], [], "a.service");
const units: [] = [];
it("fades removed nodes and edges, cancels ghosts on reentry, and clears timers on context changes", () => {
  vi.useFakeTimers();
  const scene = (layout: typeof full, scope = "dependencies") => (
    <SystemdGraphExits layout={layout} root="a.service" scope={scope} units={units} />
  );
  const view = render(scene(full));
  view.rerender(scene(small));
  expect(view.container.querySelectorAll(".systemd-graph-ghost")).toHaveLength(1);
  expect(view.container.querySelectorAll(".systemd-edge-path")).toHaveLength(1);
  expect(
    view.container.querySelector(".systemd-graph-exits[inert][aria-hidden=true]"),
  ).toBeTruthy();
  view.rerender(scene(full));
  expect(view.container.querySelectorAll(".systemd-graph-ghost")).toHaveLength(0);
  view.rerender(scene(small));
  expect(view.container.querySelectorAll(".systemd-graph-ghost")).toHaveLength(1);
  act(() => vi.advanceTimersByTime(240));
  expect(view.container.querySelectorAll(".systemd-graph-exit-scene")).toHaveLength(0);
  view.rerender(scene(full));
  view.rerender(scene(small));
  view.rerender(scene(small, "ordering"));
  expect(view.container.querySelectorAll(".systemd-graph-exit-scene")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
