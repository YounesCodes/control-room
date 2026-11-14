import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import axe from "axe-core";
import { ServicesPane } from "./ServicesPane";
import { TooltipLayer } from "../components/TooltipLayer";
import { useState } from "react";
import { SystemdGraph } from "../components/SystemdGraph";
import { systemdEdges } from "../lib/systemd-units";
import { ConnectionSection } from "../components/ResizablePanels";
import { connection } from "../test/app-fixtures";
import { systemdInspection } from "../test/systemd-fixtures";
import { invalidateSystemdReads } from "../lib/systemd-inspection";
import type { SystemdInspection, SystemdUnit } from "../types";
import "../styles.css";
import { tabKey } from "../test/keyboard";

const api = vi.hoisted(() => ({
  listServices: vi.fn(),
  inspectSystemdUnit: vi.fn(),
  listPorts: vi.fn(),
}));
vi.mock("../lib/api", () => ({ api, errorMessage: String }));
const host = connection();
const unitConfiguration =
  '# /etc/systemd/system/worker.service\n[Unit]\nDescription=Queue worker\n\n[Service]\nEnvironment="QUEUE=priority"\nExecStart=/usr/local/bin/worker --queue ${QUEUE} %i\nRestart=on-failure\n';
const units: SystemdUnit[] = [
  {
    id: "worker.service",
    unitType: "service",
    description: "Queue worker",
    activeState: "failed",
    subState: "failed",
    loadState: "loaded",
    unitFileState: "enabled",
  },
  {
    id: "database.service",
    unitType: "service",
    description: "Database",
    activeState: "active",
    subState: "running",
    loadState: "loaded",
    unitFileState: "enabled",
  },
  {
    id: "backup.timer",
    unitType: "timer",
    description: "Daily backup",
    activeState: "active",
    subState: "waiting",
    loadState: "loaded",
    unitFileState: "enabled",
  },
  {
    id: "api.socket",
    unitType: "socket",
    description: "API activation socket",
    activeState: "active",
    subState: "listening",
    loadState: "loaded",
    unitFileState: "enabled",
  },
  {
    id: "data.mount",
    unitType: "mount",
    description: "Application data",
    activeState: "active",
    subState: "mounted",
    loadState: "loaded",
    unitFileState: "generated",
  },
  {
    id: "retired.service",
    unitType: "service",
    description: "Retired worker",
    activeState: "inactive",
    subState: "dead",
    loadState: "loaded",
    unitFileState: "disabled",
  },
];

beforeEach(() => {
  invalidateSystemdReads(host.id);
  vi.clearAllMocks();
  api.inspectSystemdUnit.mockImplementation((_host, id, section) =>
    Promise.resolve(
      systemdInspection(
        id,
        section === "properties"
          ? {
              Id: id,
              Description: id === "worker.service" ? "Queue worker" : id,
              LoadState: "loaded",
              ActiveState: id === "worker.service" ? "failed" : "active",
              SubState: id === "worker.service" ? "failed" : "running",
              UnitFileState: "enabled",
              Result: "exit-code",
              ExecMainCode: "1",
              ExecMainStatus: "1",
              MainPID: "0",
              Restart: "on-failure",
              NRestarts: "3",
              MemoryCurrent: "18446744073709551615",
              FragmentPath: "/etc/systemd/system/" + id,
              ExecStart:
                '{ path=/usr/local/bin/worker ; argv[]=/usr/local/bin/worker --queue "priority jobs" ; ignore_errors=no ; }',
              ...(id === "worker.service"
                ? {
                    Requires: "database.service data.mount",
                    Wants: "network-online.target",
                    After: "database.service",
                    Before: "multi-user.target",
                    RequiredBy: "app.target",
                  }
                : id === "database.service"
                  ? { Requires: "storage.target" }
                  : {}),
            }
          : {},
        section === "configuration" ? unitConfiguration : "Restart=on-failure\nMainPID=0\n",
      ),
    ),
  );
});
afterEach(cleanup);

function renderPane(items = units) {
  return render(
    <ConnectionSection section="services">
      <ServicesPane
        connection={host}
        cache={{ items, fetchedAt: Date.now(), loading: false, error: null }}
        onCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
        onOpenPorts={vi.fn()}
      />
    </ConnectionSection>,
  );
}
async function settleMotion() {
  // Slower WebKit runners can still be finishing a transition after a second.
  await waitFor(
    () =>
      expect(
        document.getAnimations().filter((animation) => animation.playState === "running"),
      ).toHaveLength(0),
    { timeout: 3000 },
  );
}
async function audit() {
  await settleMotion();
  return axe.run(document.querySelector(".systemd-page")!);
}
function camera() {
  return document.querySelector<HTMLElement>(".systemd-graph-content")!.style.transform;
}

it("keeps search aligned and tightly spaced when switching into the dependency graph", async () => {
  await page.viewport(1280, 800);
  renderPane();
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await settleMotion();
  const before = screen.getByRole("button", { name: "Find units" }).getBoundingClientRect();
  await page.getByRole("button", { name: "Dependency graph worker.service" }).click();
  await settleMotion();
  const search = screen.getByRole("button", { name: "Find dependencies" });
  const box = search.getBoundingClientRect();
  expect(box.left).toBeCloseTo(before.left, 2);
  expect(box.width).toBe(30);
  expect(search.querySelector("svg")!.getBoundingClientRect().width).toBe(16);
  const activation = screen.getByRole("button", { name: "Activation" }).getBoundingClientRect();
  expect(box.left - activation.right).toBeLessThanOrEqual(14);
});

it.each([360, 1280])("slides the relationship category selection fill at %ipx", async (width) => {
  await page.viewport(width, 800);
  renderPane();
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await page.getByRole("button", { name: "Dependency graph worker.service" }).click();
  await settleMotion();
  const group = screen.getByRole("group", { name: "Relationship category" });
  const pose = () => {
    const style = getComputedStyle(group, "::before");
    return { x: new DOMMatrixReadOnly(style.transform).m41, width: parseFloat(style.width) };
  };
  let previous = within(group).getByRole("button", { name: "Dependencies" });
  expect(pose().x).toBeCloseTo(previous.offsetLeft, 2);
  expect(pose().width).toBeCloseTo(previous.offsetWidth, 2);
  for (const name of ["Ordering", "Activation", "Dependencies"]) {
    const next = within(group).getByRole("button", { name });
    const slides = () =>
      group
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation instanceof CSSTransition &&
            (animation.effect as KeyframeEffect).target === group,
        );
    // Pause each slide as it starts: a slow runner can otherwise finish it
    // before the test samples the midpoint.
    const hold = () => {
      for (const animation of slides()) animation.pause();
    };
    group.addEventListener("transitionrun", hold);
    next.click();
    await waitFor(() => expect(next.getAttribute("aria-pressed")).toBe("true"));
    const animations = await waitFor(() => {
      const active = slides();
      expect(active).toHaveLength(2);
      return active;
    });
    group.removeEventListener("transitionrun", hold);
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
    }
    expect(pose().x).toBeGreaterThan(Math.min(previous.offsetLeft, next.offsetLeft));
    expect(pose().x).toBeLessThan(Math.max(previous.offsetLeft, next.offsetLeft));
    for (const animation of animations) animation.finish();
    expect(pose().x).toBeCloseTo(next.offsetLeft, 2);
    expect(pose().width).toBeCloseTo(next.offsetWidth, 2);
    previous = next;
  }
  expect((await audit()).violations).toEqual([]);
});

it.each([360, 1280])("slides and resizes the view selection fill at %ipx", async (width) => {
  await page.viewport(width, 800);
  renderPane();
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await settleMotion();
  const view = screen.getByRole("group", { name: "Systemd view" });
  const explorer = within(view).getByRole("button", { name: "Explorer" });
  const relationships = within(view).getByRole("button", {
    name: "Dependency graph worker.service",
  });
  const scopeStyle = getComputedStyle(
    screen.getByRole("group", { name: "Unit scope" }),
    "::before",
  );
  const duration = scopeStyle.transitionDuration;
  const easing = scopeStyle.transitionTimingFunction;
  const pose = () => {
    const style = getComputedStyle(view, "::before");
    return { x: new DOMMatrixReadOnly(style.transform).m41, width: parseFloat(style.width) };
  };
  const transitions = () =>
    view
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation instanceof CSSTransition &&
          (animation.effect as KeyframeEffect).target === view,
      ) as CSSTransition[];
  function aligned(button: HTMLElement) {
    expect(pose().x).toBeCloseTo(button.offsetLeft, 2);
    expect(pose().width).toBeCloseTo(button.offsetWidth, 2);
  }
  aligned(explorer);
  expect(transitions()).toHaveLength(0);
  relationships.click();
  await waitFor(() => expect(relationships.getAttribute("aria-pressed")).toBe("true"));
  const style = getComputedStyle(view, "::before");
  expect(style.transitionDuration.split(",")[0]).toBe(duration);
  expect(style.transitionTimingFunction.startsWith(easing)).toBe(true);
  const forward = await waitFor(() => {
    expect(transitions()).toHaveLength(2);
    return transitions();
  });
  for (const animation of forward) {
    animation.pause();
    const duration = Number(animation.effect!.getTiming().duration);
    animation.currentTime = duration / 4;
    const early = animation.effect!.getComputedTiming().progress!;
    animation.currentTime = (duration * 3) / 4;
    const late = animation.effect!.getComputedTiming().progress!;
    expect(early + late).toBeCloseTo(1, 2);
    animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
  }
  const midway = pose();
  expect(midway.x).toBeGreaterThan(explorer.offsetLeft);
  expect(midway.x).toBeLessThan(relationships.offsetLeft);
  expect(midway.width).toBeGreaterThan(explorer.offsetWidth);
  expect(midway.width).toBeLessThan(relationships.offsetWidth);
  explorer.click();
  const reversed = await waitFor(() => {
    const next = transitions();
    expect(next).toHaveLength(2);
    expect(next.every((animation) => !forward.includes(animation))).toBe(true);
    return next;
  });
  for (const animation of reversed) {
    const first = (animation.effect as KeyframeEffect).getKeyframes()[0];
    if (animation.transitionProperty === "transform")
      expect(new DOMMatrixReadOnly(first.transform as string).m41).toBeCloseTo(midway.x, 2);
    if (animation.transitionProperty === "width")
      expect(parseFloat(first.width as string)).toBeCloseTo(midway.width, 1);
    animation.finish();
  }
  aligned(explorer);
  await page.getByRole("button", { name: "Dependency graph worker.service" }).click();
  await settleMotion();
  aligned(relationships);
  await page.viewport(width === 360 ? 1280 : 360, 800);
  await waitFor(() => aligned(relationships));
  expect((await audit()).violations).toEqual([]);
});

it("shows Ports only on the unit with known listener ownership", async () => {
  await page.viewport(1280, 800);
  const onOpenPorts = vi.fn();
  render(
    <ConnectionSection section="services">
      <ServicesPane
        connection={host}
        cache={{ items: units, fetchedAt: Date.now(), loading: false, error: null }}
        portsCache={{
          items: [
            {
              id: "tcp:5432",
              protocol: "tcp",
              addressFamily: "ipv4",
              localAddress: "127.0.0.1",
              port: 5432,
              processId: 42,
              processName: "database",
              systemdUnit: "database.service",
              ownership: "known",
            },
          ],
          fetchedAt: Date.now(),
          loading: false,
          error: null,
        }}
        onPortsCacheChange={vi.fn()}
        onCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
        onOpenPorts={onOpenPorts}
      />
    </ConnectionSection>,
  );
  await page.getByRole("button", { name: "All units" }).click();
  for (const id of ["data.mount", "worker.service", "database.service"]) {
    await page.getByRole("button", { name: new RegExp("^" + id) }).click();
    await page.getByText("Advanced", { exact: true }).click();
    expect(!!screen.queryByRole("button", { name: "Ports" })).toBe(id === "database.service");
  }
  await page.getByRole("button", { name: "Ports", exact: true }).click();
  expect(onOpenPorts).toHaveBeenCalledWith("database.service");
  expect(api.listPorts).not.toHaveBeenCalled();
  expect((await audit()).violations).toEqual([]);
});

it.each([360, 1280])(
  "keeps configuration directly accessible and the full journal action fixed at %ipx",
  async (width) => {
    await page.viewport(width, 500);
    renderPane();
    await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
    const inspector = screen.getByRole("complementary", { name: "Unit details" });
    expect(within(inspector).queryByText("Recent journal")).toBeNull();
    expect(
      [...inspector.querySelectorAll("summary")].map((summary) => summary.textContent),
    ).toEqual(["Configuration", "Advanced"]);
    expect(
      api.inspectSystemdUnit.mock.calls.some(([, , section]) => section === "configuration"),
    ).toBe(false);
    await page.getByText("Configuration", { exact: true }).click();
    await waitFor(() =>
      expect(api.inspectSystemdUnit).toHaveBeenCalledWith(
        host.id,
        "worker.service",
        "configuration",
      ),
    );
    const code = await screen.findByLabelText("Unit files");
    expect(code.textContent).toBe(unitConfiguration);
    expect(getComputedStyle(code).fontFamily).toContain("monospace");
    expect(getComputedStyle(code.querySelector("code")!).fontFamily).toBe(
      getComputedStyle(code).fontFamily,
    );
    expect(
      [...code.querySelectorAll(".systemd-code-section")].map((section) => section.textContent),
    ).toEqual(["[Unit]", "[Service]"]);
    expect(code.querySelector(".systemd-code-key")?.textContent).toBe("Description");
    expect(getComputedStyle(code.querySelector(".systemd-code-section")!).color).not.toBe(
      getComputedStyle(code.querySelector(".systemd-code-key")!).color,
    );
    expect(within(inspector).queryByText("Dependencies", { selector: "summary" })).toBeNull();
    expect(screen.getByText("Advanced").closest("details")?.open).toBe(false);
    await page.getByText("Advanced", { exact: true }).click();
    const command = await screen.findByLabelText("ExecStart");
    expect(command.closest(".inspector-wide-field")).toBeTruthy();
    expect(command.textContent).toContain('argv[]=/usr/local/bin/worker --queue "priority jobs"');
    expect(command.querySelectorAll(".systemd-code-break")).toHaveLength(3);
    expect(command.getBoundingClientRect().width).toBeGreaterThan(200);
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(command);
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboardData = new DataTransfer();
    command.dispatchEvent(
      new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }),
    );
    expect(clipboardData.getData("text/plain")).toBe(command.textContent);
    selection.removeAllRanges();
    await settleMotion();
    const journal = within(inspector).getByRole("button", { name: "View journal" });
    const body = inspector.querySelector<HTMLElement>(".port-inspector-body")!;
    expect(journal.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      body.getBoundingClientRect().bottom - 1,
    );
    expect(journal.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      inspector.getBoundingClientRect().bottom,
    );
    expect(inspector.getBoundingClientRect().bottom).toBeLessThanOrEqual(500);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(api.inspectSystemdUnit.mock.calls.some(([, , section]) => section === "journal")).toBe(
      false,
    );
    expect((await audit()).violations).toEqual([]);
  },
);

it.each([360, 640, 960, 1280])(
  "keeps exiting controls clear of the heading text at %ipx",
  async (width) => {
    await page.viewport(width, 800);
    renderPane();
    await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
    await settleMotion();
    const heading = screen.getByRole("heading", { name: "Systemd" });
    const count = document.querySelector<HTMLElement>(".systemd-unit-count")!;
    const view = screen.getByRole("group", { name: "Systemd view" });
    const protectedText = [heading, count, ...view.querySelectorAll("button")];
    const poses = protectedText.map((label) => label.getBoundingClientRect());
    for (const mode of ["relationships", "inventory"]) {
      screen
        .getByRole("button", {
          name: mode === "inventory" ? "Explorer" : /^Dependency graph(?: |$)/,
        })
        .click();
      await screen.findByRole("group", {
        name: mode === "inventory" ? "Unit scope" : "Relationship category",
      });
      const started = performance.now();
      do {
        protectedText.forEach((label, index) => {
          const pose = label.getBoundingClientRect();
          for (const coordinate of ["x", "y", "width", "height"] as const)
            expect(pose[coordinate], label.textContent + " " + coordinate).toBeCloseTo(
              poses[index][coordinate],
              1,
            );
          expect(getComputedStyle(label).opacity).toBe("1");
          expect(getComputedStyle(label).transform).toBe("none");
        });
        const leaving = document.querySelectorAll<HTMLElement>(
          ".systemd-heading .systemd-presence[data-leaving] > :is(.systemd-scope-switch, .systemd-relationship-groups)",
        );
        for (const control of leaving) {
          if (Number(getComputedStyle(control).opacity) < 0.02) continue;
          const bounds = control.getBoundingClientRect();
          for (const label of [heading, count, view]) {
            const text = label.getBoundingClientRect();
            const overlap =
              Math.min(bounds.right, text.right) > Math.max(bounds.left, text.left) &&
              Math.min(bounds.bottom, text.bottom) > Math.max(bounds.top, text.top);
            expect(overlap, control.className + " covers " + label.textContent).toBe(false);
          }
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      } while (performance.now() - started < 220);
    }
  },
);

it.each([360, 640, 960, 1280])(
  "keeps relationship controls in their final layout throughout view switching at %ipx",
  async (width) => {
    await page.viewport(width, 800);
    renderPane();
    await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
    await settleMotion();
    const count = document.querySelector<HTMLElement>(".systemd-unit-count")!;
    const inventoryCount = count.textContent;
    screen.getByRole("button", { name: /^Dependency graph(?: |$)/ }).click();
    const group = await screen.findByRole("group", { name: "Relationship category" });
    async function stableLayout(element: HTMLElement) {
      const samples: number[][] = [];
      const started = performance.now();
      do {
        expect(count.textContent).toBe(inventoryCount);
        samples.push([
          element.offsetLeft,
          element.offsetTop,
          element.closest<HTMLElement>(".systemd-heading")!.offsetHeight,
          count.offsetLeft,
          count.offsetTop,
          count.offsetWidth,
        ]);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      } while (performance.now() - started < 320);
      for (let coordinate = 0; coordinate < 6; coordinate++) {
        const values = samples.map((sample) => sample[coordinate]);
        expect(
          Math.max(...values) - Math.min(...values),
          JSON.stringify(samples),
        ).toBeLessThanOrEqual(1);
      }
    }
    await stableLayout(group);
    expect(
      screen.getByRole("button", { name: /^Dependency graph(?: |$)/, pressed: true }),
    ).toBeTruthy();
    screen.getByRole("button", { name: "Explorer" }).click();
    await stableLayout(await screen.findByRole("group", { name: "Unit scope" }));
    screen.getByRole("button", { name: /^Dependency graph(?: |$)/ }).click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    screen.getByRole("button", { name: "Explorer" }).click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    screen.getByRole("button", { name: /^Dependency graph(?: |$)/ }).click();
    await stableLayout(await screen.findByRole("group", { name: "Relationship category" }));
  },
);

it.each([360, 960])("names the relationship target without overflowing at %ipx", async (width) => {
  await page.viewport(width, 800);
  const id = "application-with-a-very-long-service-name-".repeat(3) + ".service";
  renderPane([{ ...units[1], id }]);
  expect(
    (screen.getByRole("button", { name: "Dependency graph" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await page.getByRole("button", { name: new RegExp("^" + id) }).click();
  const action = screen.getByRole("button", { name: "Dependency graph " + id });
  expect(action.querySelector(".systemd-unit-target")!.textContent).toBe(id.slice(0, 23) + "…");
  expect(action.title).toContain(id);
  expect(action.textContent).toContain("Dependency graph");
  const bounds = action.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  await page.getByRole("button", { name: "Dependency graph " + id }).click();
  expect(screen.getByTitle("Refocus on current unit").textContent).toBe(id);
});

it.each([1000, 1280])(
  "keeps the relationship name slot and scope controls steady across selections at %ipx",
  async (width) => {
    await page.viewport(width, 800);
    const ids = [
      "a.service",
      "database.service",
      "actions.runner.YounesCodes-control-room.production-worker.service",
    ];
    renderPane(ids.map((id) => ({ ...units[1], id })));
    let left: number | undefined;
    for (const id of ids) {
      await page.getByRole("button", { name: id + " Database Running" }).click();
      await settleMotion();
      const scope = screen.getByRole("group", { name: "Unit scope" });
      left ??= scope.getBoundingClientRect().left;
      expect(scope.getBoundingClientRect().left).toBeCloseTo(left, 2);
      const refresh = screen
        .getByRole("button", { name: "Refresh systemd units" })
        .getBoundingClientRect();
      expect(
        document.querySelector(".systemd-heading")!.getBoundingClientRect().right - refresh.right,
      ).toBeLessThanOrEqual(16);
      const search = screen
        .getByRole("button", { name: "Filter and sort units" })
        .getBoundingClientRect();
      expect(search.left - scope.getBoundingClientRect().right).toBeGreaterThanOrEqual(0);
      expect(search.left - scope.getBoundingClientRect().right).toBeLessThan(20);
      const action = screen.getByRole("button", { name: "Dependency graph " + id });
      const target = action.querySelector<HTMLElement>(".systemd-unit-target")!;
      expect(target.textContent).toBe(id.length > 24 ? id.slice(0, 23) + "…" : id);
      if (id === "a.service") expect(target.clientWidth).toBeLessThan(100);
      expect(action.title).toContain(id);
    }
  },
);

it("keeps the unit count width and view switch position stable across scopes", async () => {
  await page.viewport(1280, 800);
  renderPane();
  const count = document.querySelector<HTMLElement>(".systemd-unit-count")!;
  const view = screen.getByRole("group", { name: "Systemd view" });
  const width = count.getBoundingClientRect().width;
  const left = view.getBoundingClientRect().left;
  for (const scope of ["All units", "Focused"]) {
    await page.getByRole("button", { name: scope, exact: true }).click();
    await settleMotion();
    expect(count.getBoundingClientRect().width).toBeCloseTo(width, 2);
    expect(view.getBoundingClientRect().left).toBeCloseTo(left, 2);
  }
});

it("reveals the inventory on scope changes and continues an interrupted reveal without remounting rows", async () => {
  await page.viewport(1280, 800);
  renderPane();
  await page.getByRole("button", { name: /database.service Database/ }).click();
  await settleMotion();
  const rows = document.querySelector<HTMLElement>(".systemd-inventory-rows")!;
  const database = screen.getByRole("button", { name: /database.service Database/ });
  const all = screen.getByRole("button", { name: "All units" });
  const focused = screen.getByRole("button", { name: "Focused" });
  const reveal = () =>
    rows
      .getAnimations()
      .find(
        (animation) =>
          (animation.effect as KeyframeEffect).target === rows &&
          !(animation instanceof CSSAnimation) &&
          !(animation instanceof CSSTransition),
      );
  expect(reveal()).toBeUndefined();
  all.focus();
  all.click();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /data.mount Application data/ })).toBeTruthy(),
  );
  expect(document.activeElement).toBe(all);
  expect(screen.getByRole("button", { name: /database.service Database/ })).toBe(database);
  expect(database.getAttribute("aria-pressed")).toBe("true");

  const animation = await waitFor(() => {
    expect(reveal()).toBeTruthy();
    return reveal()!;
  });
  animation.pause();
  animation.currentTime = 0;
  expect(Number(getComputedStyle(rows).opacity)).toBeCloseTo(0.45);
  expect(new DOMMatrixReadOnly(getComputedStyle(rows).transform).m42).toBe(8);
  animation.currentTime = 120;
  const midway = getComputedStyle(rows);
  expect(Number(midway.opacity)).toBeGreaterThan(0.45);
  expect(Number(midway.opacity)).toBeLessThan(1);
  expect(new DOMMatrixReadOnly(midway.transform).m42).toBeGreaterThan(0);
  expect(new DOMMatrixReadOnly(midway.transform).m42).toBeLessThan(8);
  animation.play();
  focused.focus();
  focused.click();
  const returning = await waitFor(() => {
    expect(reveal()).toBeTruthy();
    expect(reveal()).not.toBe(animation);
    return reveal()!;
  });
  expect(animation.playState).toBe("idle");
  const start = (returning.effect as KeyframeEffect).getKeyframes()[0];
  expect(Number(start.opacity)).toBeGreaterThan(0.45);
  expect(new DOMMatrixReadOnly(start.transform as string).m42).toBeLessThan(8);
  returning.finish();
  expect(Number(getComputedStyle(rows).opacity)).toBe(1);
  expect(getComputedStyle(rows).transform).toBe("none");
  expect(document.activeElement).toBe(focused);
  expect(screen.getByRole("button", { name: /database.service Database/ })).toBe(database);
  expect(screen.queryByRole("button", { name: /data.mount Application data/ })).toBeNull();
  await page.getByRole("button", { name: "Find units", exact: true }).click();
  await page.getByRole("textbox", { name: "Search units" }).fill("database");
  expect(reveal()).toBeUndefined();
});

it("keeps the scope switch accessible at narrow widths and preserves complete graph evidence", async () => {
  await page.viewport(640, 720);
  renderPane();
  const focused = page.getByRole("button", { name: "Focused" });
  const all = page.getByRole("button", { name: "All units" });
  expect(screen.queryByRole("button", { name: /data.mount Application data/ })).toBeNull();
  await all.click();
  await page.getByRole("button", { name: /data.mount Application data/ }).click();
  await focused.click();
  expect(screen.getByRole("status").textContent).toContain("Selected unit is outside this filter");
  await page.getByRole("button", { name: "Show selected unit" }).click();
  expect(screen.getByRole("heading", { name: "data.mount" })).toBeTruthy();
  await focused.click();
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await page.getByRole("button", { name: /^Dependency graph(?: |$)/ }).click();
  const graph = screen.getByRole("region", { name: "Systemd dependency graph" });
  expect(await within(graph).findByRole("button", { name: /^data.mount/ })).toBeTruthy();
  await page.getByRole("button", { name: "Explorer" }).click();
  await settleMotion();
  const scope = screen.getByRole("group", { name: "Unit scope" });
  const bounds = scope.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  const selectedFill = getComputedStyle(scope, "::before");
  const duration = parseFloat(selectedFill.transitionDuration);
  expect(duration).toBe(0.18);
  // Sample the rendered fill between the two options, including reversal.
  screen.getByRole("button", { name: "All units" }).click();
  const slide = await waitFor(() => {
    const transition = scope
      .getAnimations({ subtree: true })
      .find(
        (animation) =>
          animation instanceof CSSTransition && animation.transitionProperty === "transform",
      );
    expect(transition).toBeTruthy();
    return transition!;
  });
  slide.pause();
  slide.currentTime = 90;
  const offset = new DOMMatrixReadOnly(getComputedStyle(scope, "::before").transform).m41;
  expect(offset).toBeGreaterThan(0);
  expect(offset).toBeLessThan(bounds.width / 2);
  screen.getByRole("button", { name: "Focused" }).click();
  await settleMotion();
  expect(new DOMMatrixReadOnly(getComputedStyle(scope, "::before").transform).m41).toBe(0);
  screen.getByRole("button", { name: "Focused" }).focus();
  await userEvent.keyboard(tabKey + "{Enter}");
  expect(screen.getByRole("button", { name: "All units", pressed: true })).toBeTruthy();
  expect((await audit()).violations).toEqual([]);
});

it("glides one shared service highlight and retargets it during rapid switching", async () => {
  await page.viewport(1280, 800);
  renderPane(["a", "b", "c"].map((name) => ({ ...units[1], id: name + ".service" })));
  await page.getByRole("button", { name: /^a.service Database/ }).click();
  await settleMotion();
  const marker = document.querySelector<HTMLElement>(".systemd-selection-indicator")!;

  await page.getByRole("button", { name: /^c.service Database/ }).click();
  expect(document.querySelectorAll(".systemd-selection-indicator")).toHaveLength(1);
  expect(document.querySelector(".systemd-selection-indicator")).toBe(marker);
  expect(screen.getByRole("heading", { name: "c.service" })).toBeTruthy();
  const motion = marker.getAnimations()[0];
  motion.pause();
  motion.currentTime = 80;
  const middle = new DOMMatrix(getComputedStyle(marker).transform).m42;
  expect(middle).toBeGreaterThan(0);
  expect(middle).toBeLessThan(88);
  await page.getByRole("button", { name: /^b.service Database/ }).click();
  const retargeted = marker.getAnimations()[0];
  retargeted.pause();
  retargeted.currentTime = 0;
  expect(Math.abs(new DOMMatrix(getComputedStyle(marker).transform).m42 - middle)).toBeLessThan(1);
  retargeted.finish();
  await settleMotion();
  // The glide can start after the first settle check on slower runners.
  await waitFor(() => expect(new DOMMatrix(getComputedStyle(marker).transform).m42).toBe(44));
  expect(marker.getBoundingClientRect().height).toBe(44);
  expect(getComputedStyle(marker).borderRadius).not.toBe("0px");
  const row = document.querySelector<HTMLElement>(".systemd-inventory .selected-row")!;
  expect(marker.getBoundingClientRect().top).toBe(row.getBoundingClientRect().top);
  row.focus();
  await userEvent.keyboard("{ArrowDown}");
  await settleMotion();
  // The glide can start after the first settle check on slower runners.
  await waitFor(() => expect(new DOMMatrix(getComputedStyle(marker).transform).m42).toBe(88));
  expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");
  expect(getComputedStyle(document.activeElement!).outlineStyle).toBe("none");
  await page.getByRole("button", { name: "Find units", exact: true }).click();
  await page.getByRole("textbox", { name: "Search units" }).fill("a.service");
  await waitFor(() => expect(document.querySelector(".systemd-selection-indicator")).toBeNull());
});

it.each([360, 1000, 1280])(
  "keeps Dependency graph stationary throughout search toggles at %ipx",
  async (width) => {
    await page.viewport(width, 800);
    for (const id of [
      null,
      "worker.service",
      "actions.runner.YounesCodes-control-room.production-worker.service",
    ]) {
      const view = renderPane(
        id ? [{ ...units[0], id, activeState: "active", subState: "running" }] : [],
      );
      if (id) await page.getByRole("button", { name: new RegExp(id + " Queue worker") }).click();
      await settleMotion();
      const group = screen.getByRole("group", { name: "Systemd view" });
      const explorer = within(group).getByRole("button", { name: "Explorer" });
      const relationships = group.querySelectorAll("button")[1];
      const fixed = [
        group,
        relationships,
        screen.getByRole("button", { name: "Refresh systemd units" }),
      ];
      const boxes = fixed.map((item) => item.getBoundingClientRect());
      const steady = () =>
        fixed.forEach((item, index) => {
          const box = item.getBoundingClientRect();
          for (const dimension of ["left", "top", "width", "height"] as const)
            expect(box[dimension]).toBeCloseTo(boxes[index][dimension], 1);
        });
      const before = {
        group: group.getBoundingClientRect().width,
        button: relationships.getBoundingClientRect().width,
      };
      screen.getByRole("button", { name: "Find units" }).click();
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "Search units" })).toBeTruthy(),
      );
      const field = document.querySelector(".systemd-inline-search")!;
      const animations = field.getAnimations();
      for (const animation of animations) animation.pause();
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        for (const animation of animations)
          animation.currentTime = Number(animation.effect!.getTiming().duration) * fraction;
        expect(group.getBoundingClientRect().width).toBeLessThanOrEqual(before.group + 0.1);
        steady();
        expect(relationships.getBoundingClientRect().width).toBeLessThanOrEqual(
          before.button + 0.1,
        );
        expect(
          relationships.getBoundingClientRect().left - explorer.getBoundingClientRect().right,
        ).toBeCloseTo(2, 1);
      }
      for (const animation of animations) animation.finish();
      await settleMotion();
      steady();
      expect(group.getBoundingClientRect().width).toBeLessThanOrEqual(before.group + 0.1);
      expect(
        screen.getByRole("textbox", { name: "Search units" }).getBoundingClientRect().width,
      ).toBeGreaterThanOrEqual(120);
      const context = document.querySelector(".systemd-mode-tools")!.getBoundingClientRect();
      const rect = group.getBoundingClientRect();
      if (context.top < rect.bottom) expect(context.left - rect.right).toBeGreaterThanOrEqual(8);
      screen.getByRole("button", { name: "Hide search" }).click();
      await waitFor(() =>
        expect(screen.queryByRole("textbox", { name: "Search units" })).toBeNull(),
      );
      const closing = field.getAnimations();
      for (const animation of closing) animation.pause();
      for (const fraction of [0, 0.5, 1]) {
        for (const animation of closing)
          animation.currentTime = Number(animation.effect!.getTiming().duration) * fraction;
        steady();
      }
      for (const animation of closing) animation.finish();
      await settleMotion();
      steady();
      view.unmount();
    }
  },
);

it.each([900, 960, 1000, 1100, 1280])(
  "keeps search inline beside a long relationship target at %ipx",
  async (width) => {
    await page.viewport(width, 800);
    const id = "actions.runner.YounesCodes-control-room.production-worker.service";
    renderPane([
      { ...units[0], id, activeState: "active", subState: "running" },
      ...Array.from({ length: 247 }, (_, index) => ({ ...units[4], id: `data-${index}.mount` })),
    ]);
    await page.getByRole("button", { name: new RegExp(id + " Queue worker") }).click();
    await settleMotion();
    const heading = document.querySelector<HTMLElement>(".systemd-heading")!;
    for (const graph of [false, true]) {
      if (graph) {
        await page.getByRole("button", { name: "Dependency graph " + id }).click();
        await settleMotion();
      }
      const height = heading.getBoundingClientRect().height;
      await page
        .getByRole("button", { name: graph ? "Find dependencies" : "Find units", exact: true })
        .click();
      await settleMotion();
      const input = screen.getByRole("textbox", {
        name: graph ? "Search dependencies" : "Search units",
      });
      expect(input.getBoundingClientRect().width).toBeGreaterThanOrEqual(120);
      expect(heading.getBoundingClientRect().height).toBe(height);
      const mode = screen.getByRole("group", { name: "Systemd view" });
      const actions = document.querySelector<HTMLElement>(".systemd-toolbar-actions")!;
      expect(actions.getBoundingClientRect().top).toBeLessThan(mode.getBoundingClientRect().bottom);
      expect(actions.getBoundingClientRect().right).toBeLessThanOrEqual(
        heading.getBoundingClientRect().right,
      );
      expect(screen.getByRole("button", { name: "Dependency graph " + id }).title).toContain(id);
      await page.getByRole("button", { name: "Hide search", exact: true }).click();
      await settleMotion();
    }
  },
);

it.each(["inventory", "graph"])(
  "clears a query before hiding search with X in %s",
  async (mode) => {
    renderPane();
    if (mode === "graph") {
      await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
      await page.getByRole("button", { name: /^Dependency graph(?: |$)/ }).click();
    }
    const name = mode === "graph" ? "Find dependencies" : "Find units";
    const inputName = mode === "graph" ? "Search dependencies" : "Search units";
    await page.getByRole("button", { name }).click();
    const input = screen.getByRole("textbox", { name: inputName });
    await page.getByRole("textbox", { name: inputName }).fill("database");
    await page.getByRole("button", { name: "Clear search" }).click();
    expect(input).toHaveValue("");
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("textbox", { name: inputName })).toBe(input);
    await page.getByRole("button", { name: "Hide search" }).click();
    expect(screen.queryByRole("textbox", { name: inputName })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name }));
    if (input.isConnected) expect(input.closest("[inert][aria-hidden=true]")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".systemd-inline-search")).toBeNull());
    await page.getByRole("button", { name }).click();
    expect(screen.getByRole("textbox", { name: inputName })).toHaveValue("");
    await page.getByRole("button", { name: "Hide search" }).click();
    expect(screen.queryByRole("textbox", { name: inputName })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name }));
  },
);

it("removes the search field outline after clicking its magnifier to collapse", async () => {
  renderPane();
  const magnifier = page.getByRole("button", { name: "Find units", exact: true });
  await magnifier.click();
  const control = document.querySelector<HTMLElement>(".systemd-search-control")!;
  await settleMotion();
  expect(getComputedStyle(control).borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
  await magnifier.click();
  await waitFor(() => expect(control.querySelector(".systemd-inline-search")).toBeNull());
  await settleMotion();
  await waitFor(() => expect(getComputedStyle(control).borderTopColor).toBe("rgba(0, 0, 0, 0)"));
  expect(getComputedStyle(control).boxShadow).toBe("none");
  await magnifier.click();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(control.querySelector(".systemd-inline-search")).toBeNull());
  await settleMotion();
  await waitFor(() => expect(getComputedStyle(control).borderTopColor).toBe("rgba(0, 0, 0, 0)"));
  const button = screen.getByRole("button", { name: "Find units" });
  expect(button.matches(":focus-visible")).toBe(true);
  expect(getComputedStyle(button).outlineStyle).not.toBe("none");
});

it("switches units immediately with arrows and keeps late details out of the current inspector", async () => {
  await page.viewport(1280, 800);
  const pending = new Map<string, (value: SystemdInspection) => void>();
  api.inspectSystemdUnit.mockImplementation(
    (_host, id) => new Promise<SystemdInspection>((resolve) => pending.set(id, resolve)),
  );
  renderPane(
    ["a", "b", "c"].map((name) => ({
      ...units[1],
      id: name + ".service",
      description: name,
    })),
  );
  const list = screen.getByRole("region", { name: "Systemd units" });
  list.focus();
  await userEvent.keyboard("{ArrowDown}");
  const inspector = screen.getByRole("complementary", { name: "Unit details" });
  expect(screen.getByRole("heading", { name: "a.service" })).toBeTruthy();
  expect(document.activeElement).toBe(within(list).getByRole("button", { name: /^a.service/ }));
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  expect(screen.getByRole("heading", { name: "c.service" })).toBeTruthy();
  expect(screen.getByRole("complementary")).toBe(inspector);
  expect(document.activeElement).toBe(within(list).getByRole("button", { name: /^c.service/ }));
  const heading = inspector.querySelector<HTMLElement>("header")!;

  expect(getComputedStyle(heading).animationName).toBe("systemd-unit-in");
  const animation = heading.getAnimations()[0];
  animation.pause();
  animation.currentTime = 0;
  const start = getComputedStyle(heading);
  expect(Number(start.opacity)).toBeLessThan(1);
  expect(new DOMMatrix(start.transform).m42).toBeGreaterThan(0);
  animation.finish();
  for (const id of ["b.service", "a.service", "c.service"]) {
    pending.get(id)!(
      systemdInspection(id, {
        ActiveState: "active",
        SubState: "running",
        MainPID: id === "c.service" ? "333" : "111",
      }),
    );
  }
  await waitFor(() => expect(within(inspector).getByText("333")).toBeTruthy());
  expect(within(inspector).queryByText("111")).toBeNull();
  await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
  expect(screen.getByRole("heading", { name: "a.service" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(document.activeElement).toBe(within(list).getByRole("button", { name: /^a.service/ }));
});

it.each([360, 1280])(
  "switches from the focused inspector without stealing native keys at %s px",
  async (width) => {
    await page.viewport(width, 800);
    renderPane(["a", "b", "c"].map((name) => ({ ...units[1], id: name + ".service" })));
    await page.getByRole("button", { name: /^a.service Database/ }).click();
    const inspector = screen.getByRole("complementary");
    expect(document.activeElement).toBe(inspector);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}");
    expect(screen.getByRole("heading", { name: "b.service" })).toBeTruthy();
    expect(document.activeElement).toBe(inspector);
    const disclosure = within(inspector).getByText("Advanced");
    disclosure.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("heading", { name: "b.service" })).toBeTruthy();
    await page.getByRole("button", { name: "Find units", exact: true }).click();
    await userEvent.keyboard("{ArrowDown}{ArrowUp}");
    expect(screen.getByRole("heading", { name: "b.service" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search units" }));
  },
);

it("follows filtered sort order and scrolls through virtual rows during repeated arrow navigation", async () => {
  await page.viewport(1280, 600);
  renderPane(
    Array.from({ length: 1000 }, (_, index) => ({
      ...units[1],
      id: "unit-" + String(index).padStart(4, "0") + ".service",
    })),
  );
  const list = screen.getByRole("region", { name: "Systemd units" });
  list.focus();
  await userEvent.keyboard("{End}{ArrowUp}{ArrowUp}");
  expect(screen.getByRole("heading", { name: "unit-0997.service" })).toBeTruthy();
  const row = list.querySelector<HTMLElement>(".selected-row")!;
  expect(document.activeElement).toBe(row);
  expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    list.getBoundingClientRect().bottom + 1,
  );
  expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    list.getBoundingClientRect().top - 1,
  );
  expect(list.querySelectorAll(".dense-row").length).toBeLessThan(50);
  await page.getByRole("button", { name: "Find units", exact: true }).click();
  await page.getByRole("textbox", { name: "Search units" }).fill("unit-000");
  await waitFor(() => expect(list.querySelectorAll(".dense-row")).toHaveLength(10));
  await userEvent.keyboard("{Escape}");
  list.focus();
  await userEvent.keyboard("{ArrowUp}");
  expect(screen.getByRole("heading", { name: "unit-0009.service" })).toBeTruthy();
  await userEvent.keyboard("{ArrowUp}{ArrowDown}");
  expect(screen.getByRole("heading", { name: "unit-0009.service" })).toBeTruthy();
});

it.each([360, 960, 1400])(
  "keeps view icons full size with a long unit name at %s px",
  async (width) => {
    await page.viewport(width, 800);
    const id = "actions.runner.YounesCodes-control-room.desktop-build-runner.service";
    renderPane([{ ...units[1], id }]);
    await page.getByRole("button", { name: id + " Database Running" }).click();
    const relationship = screen.getByRole("button", { name: "Dependency graph " + id });
    const assertIcons = () => {
      for (const button of [relationship, screen.getByRole("button", { name: "Explorer" })]) {
        const bounds = button.querySelector("svg")!.getBoundingClientRect();
        expect(bounds.width).toBe(14);
        expect(bounds.height).toBe(14);
      }
    };
    assertIcons();
    await page.getByRole("button", { name: "Find units", exact: true }).click();
    await settleMotion();
    assertIcons();
  },
);

it("does not flash the field when search is dismissed during the icon's travel", async () => {
  await page.viewport(1280, 800);
  renderPane();
  await page.getByRole("button", { name: "Find units", exact: true }).click();
  const search = document.querySelector<HTMLElement>(".systemd-inline-search")!;

  const opening = search
    .getAnimations()
    .find((item) => (item as CSSAnimation).animationName === "systemd-search-in")!;
  opening.pause();
  opening.currentTime = 80;
  expect(Number(getComputedStyle(search).opacity)).toBe(0);
  const width = search.getBoundingClientRect().width;
  await userEvent.keyboard("{Escape}");
  const closing = search
    .getAnimations()
    .find((item) => (item as CSSAnimation).animationName === "systemd-search-out")!;
  closing.pause();
  closing.currentTime = 0;
  expect(Number(getComputedStyle(search).opacity)).toBe(0);
  expect(search.getBoundingClientRect().width).toBeLessThanOrEqual(width + 1);
  closing.currentTime = 60;
  expect(Number(getComputedStyle(search).opacity)).toBe(0);
  const partial = search.getBoundingClientRect().width;
  await userEvent.keyboard("{Enter}");
  const reopened = search
    .getAnimations()
    .find((item) => (item as CSSAnimation).animationName === "systemd-search-in")!;
  reopened.pause();
  reopened.currentTime = 0;
  expect(Math.abs(search.getBoundingClientRect().width - partial)).toBeLessThanOrEqual(1);
  expect(Number(getComputedStyle(search).opacity)).toBe(0);
  reopened.finish();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.querySelector(".systemd-inline-search")).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Find units" }));
});

it.each([360, 960, 1400])(
  "keeps search inline and anchors filters below their icon at %s px",
  async (width) => {
    await page.viewport(width, 800);
    renderPane();
    await page.getByRole("button", { name: "Find units", exact: true }).click();
    const input = screen.getByRole("textbox", { name: "Search units" });
    expect(document.activeElement).toBe(input);
    expect(input.closest(".systemd-heading")).toBeTruthy();
    expect(document.querySelector(".systemd-tools-panel")).toBeNull();
    const search = input.closest<HTMLElement>(".systemd-inline-search")!;
    const animation = search
      .getAnimations()
      .find((item) => (item as CSSAnimation).animationName === "systemd-search-in")!;
    animation.pause();
    animation.currentTime = 0;
    const start = search.getBoundingClientRect().width;
    const iconStart = screen
      .getByRole("button", { name: "Find units" })
      .getBoundingClientRect().left;
    animation.currentTime = 120;
    expect(search.getBoundingClientRect().width).toBeGreaterThan(start);
    expect(
      screen.getByRole("button", { name: "Find units" }).getBoundingClientRect().left,
    ).toBeLessThan(iconStart);
    expect(Number(getComputedStyle(search).opacity)).toBe(0);
    animation.currentTime = 260;
    expect(Number(getComputedStyle(search).opacity)).toBeGreaterThan(0);
    animation.finish();
    await settleMotion();
    const header = document.querySelector(".systemd-heading")!.getBoundingClientRect();
    const box = search.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(header.top);
    expect(box.bottom).toBeLessThanOrEqual(header.bottom);
    expect(box.left).toBeGreaterThanOrEqual(
      screen.getByRole("button", { name: "Find units" }).getBoundingClientRect().right - 1,
    );
    const control = search.closest<HTMLElement>(".systemd-search-control")!;
    const icon = screen.getByRole("button", { name: "Find units" });
    expect(control.contains(icon)).toBe(true);
    expect(control.contains(screen.getByRole("button", { name: "Hide search" }))).toBe(true);
    const iconBounds = icon.getBoundingClientRect();
    const controlBounds = control.getBoundingClientRect();
    expect(box.height).toBe(iconBounds.height);
    expect(box.top).toBe(iconBounds.top);
    expect(controlBounds.width).toBeGreaterThan(box.width);
    expect(controlBounds.left).toBeGreaterThanOrEqual(header.left);
    expect(controlBounds.right).toBeLessThanOrEqual(header.right);
    expect(getComputedStyle(control).boxShadow).toBe("none");
    expect(getComputedStyle(control).borderTopWidth).toBe("1px");
    expect(getComputedStyle(search).borderTopWidth).toBe("0px");
    await page.getByRole("textbox", { name: "Search units" }).fill("database");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /worker.service Queue worker/ })).toBeNull(),
    );
    await page.getByRole("button", { name: "Clear search" }).click();
    expect(input).toHaveValue("");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /worker.service Queue worker/ })).toBeTruthy(),
    );
    expect((await audit()).violations).toEqual([]);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Search units" })).toBeNull();
    const closing = search
      .getAnimations()
      .find((item) => (item as CSSAnimation).animationName === "systemd-search-out")!;
    closing.pause();
    closing.currentTime = 0;
    const expanded = search.getBoundingClientRect().width;
    closing.currentTime = 150;
    expect(search.getBoundingClientRect().width).toBeLessThan(expanded);
    closing.finish();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Find units" }));
    await page.getByRole("button", { name: "Filter and sort units" }).click();
    await settleMotion();
    const panel = screen.getByRole("region", { name: "Unit filters" });
    const filterIcon = screen.getByRole("button", { name: "Filter and sort units" });
    const panelBox = panel.getBoundingClientRect(),
      iconBox = filterIcon.getBoundingClientRect();
    expect(panelBox.top - iconBox.bottom).toBeGreaterThanOrEqual(8);
    expect(
      panelBox.top -
        Math.max(
          iconBox.bottom,
          document.querySelector(".systemd-heading")!.getBoundingClientRect().bottom,
        ),
    ).toBeLessThanOrEqual(26);
    expect(panelBox.left).toBeGreaterThanOrEqual(0);
    expect(panelBox.right).toBeLessThanOrEqual(width);
    expect(iconBox.left).toBeLessThanOrEqual(panelBox.right);
    expect(panelBox.top).toBeGreaterThanOrEqual(
      document.querySelector(".systemd-heading")!.getBoundingClientRect().bottom,
    );
    expect((await audit()).violations).toEqual([]);
    const resized = width === 360 ? 520 : width - 160;
    await page.viewport(resized, 500);
    await waitFor(() => expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(500));
    await waitFor(() =>
      expect(
        Math.abs(panel.getBoundingClientRect().right - filterIcon.getBoundingClientRect().right),
      ).toBeLessThanOrEqual(12),
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(resized);
  },
);

it("toggles the selected node back to a fitted overview without changing graph focus", async () => {
  await page.viewport(960, 800);
  renderPane();
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await page.getByRole("button", { name: /^Dependency graph(?: |$)/ }).click();
  await page.getByRole("button", { name: /^database.service Running/ }).click();
  await settleMotion();
  expect(new DOMMatrix(camera()).a).toBeCloseTo(1.1);
  await page.getByRole("button", { name: /^database.service Running/ }).click();
  expect(screen.queryByRole("complementary")).toBeNull();
  await settleMotion();
  expect(new DOMMatrix(camera()).a).toBeLessThan(1.1);
  expect(screen.getByTitle("Refocus on current unit").textContent).toBe("worker.service");
  const viewport = screen.getByRole("region", { name: "Systemd dependency graph" });
  const bounds = viewport.getBoundingClientRect();
  for (const node of viewport.querySelectorAll(".systemd-graph-node")) {
    const box = node.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(bounds.left - 1);
    expect(box.right).toBeLessThanOrEqual(bounds.right + 1);
    expect(box.top).toBeGreaterThanOrEqual(bounds.top - 1);
    expect(box.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
  }
});

it("refits and zooms in both directions on show more and show less, including inspector space", async () => {
  await page.viewport(1280, 800);
  const neighbors = Array.from({ length: 20 }, (_, index) => "neighbor-" + index + ".service");
  api.inspectSystemdUnit.mockImplementation((_host, id) =>
    Promise.resolve(
      systemdInspection(id, { Requires: id === "worker.service" ? neighbors.join(" ") : "" }),
    ),
  );
  renderPane();
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await page.getByRole("button", { name: /^Dependency graph(?: |$)/ }).click();
  const graph = screen.getByRole("region", { name: "Systemd dependency graph" });
  await waitFor(() => expect(graph.querySelectorAll(".systemd-graph-node")).toHaveLength(7));
  await settleMotion();
  const scale = () => new DOMMatrix(camera()).a;
  const initial = scale();
  const focused = within(graph).getByRole("button", { name: /^worker.service Failed/ });
  const beforeExpansion = focused.getBoundingClientRect();
  const contained = async () => {
    await settleMotion();
    // The refit can begin after the first settle check on slower runners.
    await waitFor(
      () => {
        const bounds = graph.getBoundingClientRect();
        const right =
          screen.queryByRole("complementary")?.getBoundingClientRect().left ?? bounds.right;
        for (const card of graph.querySelectorAll(".systemd-graph-node")) {
          const box = card.getBoundingClientRect();
          expect(box.left).toBeGreaterThanOrEqual(bounds.left - 1);
          expect(box.right).toBeLessThanOrEqual(right + 1);
          expect(box.top).toBeGreaterThanOrEqual(bounds.top - 1);
          expect(box.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
        }
      },
      { timeout: 3000 },
    );
    await settleMotion();
  };
  // A direct click renders the expansion before the refit camera can move,
  // which a driver round trip on a slow runner cannot guarantee.
  screen.getByRole("button", { name: /Show more/ }).click();
  const firstFrame = focused.getBoundingClientRect();
  expect(
    Math.abs(
      firstFrame.top + firstFrame.height / 2 - beforeExpansion.top - beforeExpansion.height / 2,
    ),
  ).toBeLessThan(40);
  await contained();
  expect(scale()).toBeLessThan(initial);
  const first = scale();
  await page.getByRole("button", { name: /Show more/ }).click();
  await contained();
  expect(scale()).toBeLessThan(first);
  const second = scale();
  await page.getByRole("button", { name: "Show less" }).click();
  await contained();
  expect(scale()).toBeGreaterThan(second);
  await page.getByRole("button", { name: /Show more/ }).click();
  await contained();
  expect(scale()).toBeCloseTo(second);
  await page.getByRole("button", { name: /^neighbor-0.service/ }).click();
  await settleMotion();
  expect(scale()).toBeCloseTo(1.1);
  const selected = within(graph)
    .getByRole("button", { name: /^neighbor-0.service/ })
    .getBoundingClientRect();
  const viewport = graph.getBoundingClientRect();
  const panel = screen.getByRole("complementary").getBoundingClientRect();
  expect(selected.left).toBeGreaterThanOrEqual(viewport.left);
  expect(selected.right).toBeLessThanOrEqual(panel.left);
  expect(
    Math.abs(selected.top + selected.height / 2 - viewport.top - viewport.height / 2),
  ).toBeLessThan(15);
  await page.getByRole("button", { name: "Show less" }).click();
  await contained();
  expect(scale()).toBeLessThan(1.1);
  await page.getByRole("button", { name: "Close details" }).click();
  await contained();
});

it("keeps selected-node focus when a pending expanded neighborhood arrives", async () => {
  await page.viewport(1280, 800);
  let resolve!: (value: ReturnType<typeof systemdInspection>) => void;
  api.inspectSystemdUnit.mockImplementation((_host, id) =>
    id === "database.service"
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve(systemdInspection(id, { Requires: "database.service" })),
  );
  renderPane();
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await page.getByRole("button", { name: /^Dependency graph(?: |$)/ }).click();
  await page.getByRole("button", { name: "Expand database.service" }).click();
  await waitFor(() => expect(resolve).toBeTruthy());
  await page.getByRole("button", { name: /^database.service/ }).click();
  await settleMotion();
  const node = screen.getByRole("button", { name: /^database.service/ });
  const before = node.getBoundingClientRect();
  expect(new DOMMatrix(camera()).a).toBeCloseTo(1.1);
  resolve(systemdInspection("database.service", { Requires: "leaf.service" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Systemd dependency graph" })).getByRole("button", {
        name: /^leaf.service/,
      }),
    ).toBeTruthy(),
  );
  await settleMotion();
  const after = node.getBoundingClientRect();
  expect(new DOMMatrix(camera()).a).toBeCloseTo(1.1);
  expect(Math.abs(after.left - before.left)).toBeLessThan(1);
  expect(Math.abs(after.top - before.top)).toBeLessThan(1);
});

it("keeps a manual pan when a pending expansion finishes, until the next expansion action", async () => {
  await page.viewport(1280, 800);
  let resolve!: (value: ReturnType<typeof systemdInspection>) => void;
  api.inspectSystemdUnit.mockImplementation((_host, id) =>
    id === "database.service"
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve(systemdInspection(id, { Requires: "database.service" })),
  );
  renderPane();
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await page.getByRole("button", { name: /^Dependency graph(?: |$)/ }).click();
  await page.getByRole("button", { name: "Expand database.service" }).click();
  await waitFor(() => expect(resolve).toBeTruthy());
  const viewport = page.getByRole("region", { name: "Systemd dependency graph" });
  await userEvent.dragAndDrop(viewport, viewport, {
    sourcePosition: { x: 20, y: 80 },
    targetPosition: { x: 90, y: 130 },
  });
  const root = screen.getByRole("button", { name: /^worker.service Failed/ });
  const before = root.getBoundingClientRect();
  resolve(systemdInspection("database.service", { Requires: "leaf.service" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Systemd dependency graph" })).getByRole("button", {
        name: /^leaf.service/,
      }),
    ).toBeTruthy(),
  );
  await settleMotion();
  const after = root.getBoundingClientRect();
  expect(Math.abs(after.left - before.left)).toBeLessThan(1);
  expect(Math.abs(after.top - before.top)).toBeLessThan(1);
});

it("restores inspector sections and nested scroll positions separately for each view", async () => {
  await page.viewport(1280, 500);
  api.inspectSystemdUnit.mockImplementation((_host, id, section) =>
    Promise.resolve(
      systemdInspection(
        id,
        section === "properties"
          ? {
              ActiveState: "active",
              Description: "Queue worker",
              MainPID: "42",
              Restart: "always",
              TasksCurrent: "12",
            }
          : {},
        section === "configuration" ? unitConfiguration.repeat(50) : "Property=value\n".repeat(100),
      ),
    ),
  );
  renderPane();
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await page.getByText("Configuration", { exact: true }).click();
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByText("Effective properties", { exact: true }).click();
  await waitFor(() =>
    expect(screen.getByLabelText("Effective properties").textContent).toContain("Property=value"),
  );
  const body = document.querySelector<HTMLElement>(".port-inspector-body")!;
  const code = screen.getByLabelText("Unit files");
  body.scrollTop = 170;
  code.scrollTop = 120;
  expect(body.scrollTop).toBe(170);
  expect(code.scrollTop).toBe(120);
  await page.getByRole("button", { name: "Dependency graph worker.service" }).click();
  await page
    .getByRole("region", { name: "Systemd dependency graph" })
    .getByRole("button", { name: /^worker.service/ })
    .click();
  expect([...document.querySelectorAll(".systemd-inspector details[open]")]).toHaveLength(0);
  await page.getByRole("button", { name: "Explorer" }).click();
  await waitFor(() =>
    expect(document.querySelectorAll(".systemd-inspector details[open]")).toHaveLength(3),
  );
  await waitFor(() =>
    expect(document.querySelector<HTMLElement>(".port-inspector-body")!.scrollTop).toBe(170),
  );
  await waitFor(() => expect(screen.getByLabelText("Unit files").scrollTop).toBe(120));
  await page.getByRole("button", { name: "Dependency graph worker.service" }).click();
  expect(document.querySelectorAll(".systemd-inspector details[open]")).toHaveLength(0);
  expect(document.querySelector<HTMLElement>(".port-inspector-body")!.scrollTop).toBe(0);
  await page.getByRole("button", { name: "Explorer" }).click();
  await page.getByRole("button", { name: /database.service Database/ }).click();
  expect(document.querySelectorAll(".systemd-inspector details[open]")).toHaveLength(0);
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await waitFor(() =>
    expect(document.querySelectorAll(".systemd-inspector details[open]")).toHaveLength(3),
  );
  await waitFor(() =>
    expect(document.querySelector<HTMLElement>(".port-inspector-body")!.scrollTop).toBe(170),
  );
});

it("restores Explorer details after visiting Dependency graph and still deselects on explicit close", async () => {
  await page.viewport(1280, 800);
  renderPane();
  const row = page.getByRole("button", { name: /worker.service Queue worker/ });
  await row.click();
  await page.getByRole("button", { name: "Dependency graph worker.service" }).click();
  expect(screen.queryByRole("complementary", { name: "Unit details" })).toBeNull();
  await page.getByRole("button", { name: "Explorer" }).click();
  expect(screen.getByRole("complementary", { name: "Unit details" })).toBeTruthy();
  expect(row.element().getAttribute("aria-pressed")).toBe("true");
  await row.click();
  expect(screen.queryByRole("complementary", { name: "Unit details" })).toBeNull();
  expect(row.element().getAttribute("aria-pressed")).toBe("false");
});

it.each(["After", "Before"])(
  "centers the whole one-sided Ordering scene for %s evidence",
  async (property) => {
    await page.viewport(1280, 500);
    api.inspectSystemdUnit.mockImplementation((_host, id) =>
      Promise.resolve(
        systemdInspection(id, {
          [property]: Array.from({ length: 6 }, (_, index) => `neighbor-${index}.service`).join(
            " ",
          ),
        }),
      ),
    );
    renderPane();
    await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
    await page.getByRole("button", { name: "Dependency graph worker.service" }).click();
    await page.getByRole("button", { name: "Ordering", exact: true }).click();
    await waitFor(() => expect(document.querySelectorAll(".systemd-graph-node")).toHaveLength(7));
    await settleMotion();
    const plot = screen
      .getByRole("region", { name: "Systemd dependency graph" })
      .getBoundingClientRect();
    const nodes = [...document.querySelectorAll(".systemd-graph-node")].map((node) =>
      node.getBoundingClientRect(),
    );
    expect(
      (Math.min(...nodes.map((node) => node.left)) + Math.max(...nodes.map((node) => node.right))) /
        2,
    ).toBeCloseTo(plot.left + plot.width / 2, 0);
    expect(
      (Math.min(...nodes.map((node) => node.top)) + Math.max(...nodes.map((node) => node.bottom))) /
        2,
    ).toBeCloseTo(plot.top + plot.height / 2 - 6, 0);
  },
);

it("keeps mouse collapse from focusing the opposite-side root tooltip and restores keyboard focus nearby", async () => {
  await page.viewport(1280, 800);
  api.inspectSystemdUnit.mockImplementation((_host, id) =>
    Promise.resolve(
      systemdInspection(id, {
        Requires: Array.from({ length: 20 }, (_, i) => `neighbor-${i}.service`).join(" "),
      }),
    ),
  );
  render(<TooltipLayer />);
  renderPane();
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await page.getByRole("button", { name: "Dependency graph worker.service" }).click();
  await page.getByRole("button", { name: /Show more/ }).click();
  await page.getByRole("button", { name: "Show less" }).click();
  await settleMotion();
  expect(document.activeElement?.classList.contains("systemd-root-label")).toBe(false);
  expect(screen.queryByRole("tooltip", { name: "Refocus on current unit" })).toBeNull();
  await page.getByRole("button", { name: /Show more/ }).click();
  screen.getByRole("button", { name: "Show less" }).focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(document.activeElement?.textContent).toMatch(/Show more/));
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

it("reverses show-more and branch expansion with animated, noninteractive exits", async () => {
  await page.viewport(1280, 800);
  const neighbors = Array.from(
    { length: 12 },
    (_, index) => "branch-" + String(index).padStart(2, "0") + ".service",
  );
  api.inspectSystemdUnit.mockImplementation((_host, id) =>
    Promise.resolve(
      systemdInspection(id, {
        Requires:
          id === "worker.service" ? neighbors.join(" ") : id === neighbors[0] ? "leaf.service" : "",
      }),
    ),
  );
  renderPane();
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await page.getByRole("button", { name: /^Dependency graph(?: |$)/ }).click();
  const count = () => document.querySelectorAll(".systemd-graph-node").length;
  await waitFor(() => expect(count()).toBe(7));
  await page.getByRole("button", { name: /Show more/ }).click();
  expect(count()).toBe(13);
  const node = screen
    .getByRole("button", { name: /^branch-11.service/ })
    .closest<HTMLElement>(".systemd-graph-node")!;
  const animation = node
    .getAnimations()
    .find((item) => (item as CSSAnimation).animationName === "systemd-node-in")!;
  animation.pause();
  animation.currentTime = 0;
  const start = new DOMMatrix(getComputedStyle(node).transform);
  animation.currentTime = 120;
  const middle = new DOMMatrix(getComputedStyle(node).transform);
  expect(start.m42).toBeGreaterThanOrEqual(8);
  expect(middle.m42).toBeLessThan(start.m42);
  expect(middle.m42).toBeGreaterThan(0);
  animation.finish();
  expect(new DOMMatrix(getComputedStyle(node).transform).m42).toBe(0);
  const edge = document.querySelector<SVGGElement>(
    '.systemd-connection[aria-label*="branch-11.service"]',
  )!;
  const reveal = edge.getAnimations()[0];
  reveal.pause();
  reveal.currentTime = 0;
  const clipped = getComputedStyle(edge).clipPath;
  reveal.currentTime = 120;
  expect(getComputedStyle(edge).clipPath).not.toBe(clipped);
  reveal.finish();
  await page.getByRole("button", { name: "Show less" }).click();
  expect(count()).toBe(7);
  await page.getByRole("button", { name: /Show more/ }).click();
  expect(count()).toBe(13);
  await page.getByRole("button", { name: "Expand " + neighbors[0] }).click();
  await waitFor(() => expect(count()).toBe(14));
  await settleMotion();
  expect(
    getComputedStyle(screen.getByRole("button", { name: "Collapse " + neighbors[0] })).opacity,
  ).toBe("1");
  await page.getByRole("button", { name: "Collapse " + neighbors[0] }).click();
  expect(count()).toBe(13);
  expect(screen.queryByRole("button", { name: /^leaf.service/ })).toBeNull();
  const ghost = document.querySelector<HTMLElement>(
    '.systemd-graph-ghost[data-unit="leaf.service"]',
  )!;
  expect(ghost).toBeTruthy();
  expect(getComputedStyle(ghost.parentElement!).animationName).toBe("systemd-node-out");
  const fade = ghost.parentElement!.getAnimations()[0];
  fade.pause();
  fade.currentTime = 0;
  const startOpacity = Number(getComputedStyle(ghost.parentElement!).opacity);
  fade.currentTime = 120;
  const halfwayOpacity = Number(getComputedStyle(ghost.parentElement!).opacity);
  expect(halfwayOpacity).toBeGreaterThan(0);
  expect(halfwayOpacity).toBeLessThan(startOpacity);
  fade.finish();
  expect(ghost.closest("[inert][aria-hidden=true]")).toBeTruthy();
  await page.getByRole("button", { name: "Expand " + neighbors[0] }).click();
  expect(count()).toBe(14);
  expect(document.querySelector('.systemd-graph-ghost[data-unit="leaf.service"]')).toBeNull();
  await page.getByRole("button", { name: "Collapse " + neighbors[0] }).click();
  expect(count()).toBe(13);
  await page.getByRole("button", { name: "Show less" }).click();
  expect(count()).toBe(7);
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).not.toBe(screen.getByTitle("Refocus on current unit")),
  );
  await waitFor(() => expect(document.querySelectorAll(".systemd-graph-ghost")).toHaveLength(0));
});

it("explains meaningful dependency line styles and keeps ordering and activation solid", async () => {
  await page.viewport(1280, 800);
  api.inspectSystemdUnit.mockResolvedValue(
    systemdInspection("worker.service", {
      Requires: "database.service",
      Wants: "database.service data.mount",
      After: "database.service",
      Triggers: "api.socket",
    }),
  );
  renderPane();
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await page.getByRole("button", { name: /^Dependency graph(?: |$)/ }).click();
  const requires = await waitFor(() => {
    const element = document.querySelector<SVGPathElement>(
      ".relationship-requires .systemd-edge-path",
    );
    expect(element).toBeTruthy();
    return element!;
  });
  await waitFor(() =>
    expect(document.querySelector(".relationship-wants .systemd-edge-path")).toBeTruthy(),
  );
  expect(getComputedStyle(requires).strokeDasharray).toBe("none");
  expect(
    getComputedStyle(document.querySelector(".relationship-wants .systemd-edge-path")!)
      .strokeDasharray,
  ).not.toBe("none");
  expect(screen.getByLabelText("Dependency line styles").textContent).toContain("Wants only");
  expect(requires.parentElement?.getAttribute("aria-label")).toContain("Wants");
  for (const category of ["Ordering", "Activation"]) {
    await page.getByRole("button", { name: category, exact: true }).click();
    const path = await waitFor(() => {
      const element = document.querySelector<SVGPathElement>(
        category === "Ordering"
          ? ".relationship-ordering .systemd-edge-path"
          : ".relationship-activation .systemd-edge-path",
      );
      expect(element).toBeTruthy();
      return element!;
    });
    expect(getComputedStyle(path).strokeDasharray).toBe("none");
    expect(getComputedStyle(path).strokeWidth).toBe("1.5px");
    expect(screen.queryByLabelText("Dependency line styles")).toBeNull();
  }
});

it("slides relationship controls and filter panels out without leaving focusable duplicates", async () => {
  await page.viewport(1280, 800);
  renderPane();

  expect(
    (screen.getByRole("button", { name: /^Dependency graph(?: |$)/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(document.querySelectorAll(".systemd-inventory .selected-row")).toHaveLength(0);
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await page.getByRole("button", { name: /^Dependency graph(?: |$)/, exact: true }).click();
  const group = screen.getByRole("group", { name: "Relationship category" });
  expect(getComputedStyle(group).animationName).toBe("systemd-controls-in");
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  expect(screen.queryByRole("group", { name: "Relationship category" })).toBeNull();
  expect(group.parentElement?.hasAttribute("inert")).toBe(true);
  expect(getComputedStyle(group).animationName).toBe("systemd-slide-out");
  await page.getByRole("button", { name: "Filter and sort units" }).click();
  const panel = screen.getByRole("region", { name: "Unit filters" });
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Unit filters" })).toBeNull();
  expect(panel.parentElement?.hasAttribute("inert")).toBe(true);
  await waitFor(() => expect(document.querySelectorAll("[data-leaving]")).toHaveLength(0));
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  expect(screen.getAllByRole("button", { name: /^Dependency graph(?: |$)/ })).toHaveLength(1);
});

it.each([1, 1000])(
  "keeps long unit text inside a vertical inventory with %s units",
  async (count) => {
    await page.viewport(960, 800);
    renderPane(
      Array.from({ length: count }, (_, index) => ({
        ...units[1],
        id: "credentials-" + "systemd-resolved-".repeat(8) + index + ".mount",
        description: "A".repeat(600),
      })),
    );
    const list = screen.getByRole("region", { name: "Systemd units" });
    expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth + 1);
    list.scrollLeft = 1000;
    expect(list.scrollLeft).toBe(0);
    const row = list.querySelector(".dense-row")!;
    expect(row.getBoundingClientRect().height).toBe(44);
    expect(row.textContent).not.toContain("enabled");
  },
);

it("keeps a large inventory bounded, keyboard navigable and searchable from the toolbar", async () => {
  await page.viewport(1280, 800);
  renderPane(
    Array.from({ length: 4000 }, (_, index) => ({
      ...units[1],
      id: "unit-" + String(index).padStart(4, "0") + ".service",
    })),
  );
  expect(document.querySelectorAll(".dense-row").length).toBeLessThan(50);
  expect(screen.queryByRole("complementary")).toBeNull();
  const list = screen.getByRole("region", { name: "Systemd units" });
  list.focus();
  await userEvent.keyboard("{End}");
  await waitFor(() => expect(document.activeElement?.textContent).toContain("unit-3999.service"));
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("heading", { name: "unit-3999.service" })).toBeTruthy();
  await page.getByRole("button", { name: "Close details" }).click();
  await page.getByRole("button", { name: "Find units", exact: true }).click();
  await page.getByRole("textbox", { name: "Search units", exact: true }).fill("unit-0010");
  await expect
    .element(page.getByRole("button", { name: /unit-0010.service Database/ }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Find units" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Find units" }));
});

it.each(["button", "item", "escape"])(
  "deselects inspected units and removes their highlight on close by %s",
  async (method) => {
    await page.viewport(1280, 800);
    renderPane();
    const row = screen.getByRole("button", { name: /worker.service Queue worker/ });
    await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
    if (method === "button") await page.getByRole("button", { name: "Close details" }).click();
    else if (method === "item")
      await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
    else await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(row.getAttribute("aria-pressed")).toBe("false");
    expect(row.classList.contains("selected-row")).toBe(false);
    expect(document.querySelector(".systemd-selection-indicator")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Dependency graph" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
    await page.getByRole("button", { name: "Dependency graph worker.service" }).click();
    const graph = screen.getByRole("region", { name: "Systemd dependency graph" });
    const node = within(graph).getByRole("button", { name: /^worker.service/ });
    await page
      .getByRole("region", { name: "Systemd dependency graph" })
      .getByRole("button", { name: /^worker.service/ })
      .click();
    if (method === "button") await page.getByRole("button", { name: "Close details" }).click();
    else if (method === "item")
      await page
        .getByRole("region", { name: "Systemd dependency graph" })
        .getByRole("button", { name: /^worker.service/ })
        .click();
    else await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(node.getAttribute("aria-pressed")).toBe("false");
    expect(node.classList.contains("selected")).toBe(false);
    expect(screen.getByTitle("Refocus on current unit").textContent).toBe("worker.service");
    await page.getByRole("button", { name: "Explorer", exact: true }).click();
    expect(
      screen
        .getByRole("button", { name: /worker.service Queue worker/ })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(document.querySelector(".systemd-selection-indicator")).toBeNull();
  },
);

it("opens graph without an inspector, separates categories and keeps selection across view changes", async () => {
  await page.viewport(1280, 800);
  renderPane();
  await page.getByRole("button", { name: /database.service Database/ }).click();
  expect(screen.getByRole("heading", { name: "database.service" })).toBeTruthy();
  await page.getByRole("button", { name: /database.service Database/ }).dblClick();
  expect(screen.queryByRole("region", { name: "Systemd dependency graph" })).toBeNull();
  await page.getByRole("button", { name: "Close details" }).click();
  expect(screen.queryByRole("region", { name: "Systemd dependency graph" })).toBeNull();
  await page.getByRole("button", { name: /database.service Database/ }).click();
  expect(screen.getByRole("button", { name: /^Dependency graph(?: |$)/ }).title).toContain(
    "database.service",
  );
  await page.getByRole("button", { name: /^Dependency graph(?: |$)/, exact: true }).click();
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.getByTitle("Refocus on current unit").textContent).toBe("database.service");
  expect(screen.getByRole("button", { name: "Dependencies" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  await page.getByRole("button", { name: "Ordering", exact: true }).click();
  expect(screen.getByRole("button", { name: "Ordering" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  expect(
    screen.getByRole("button", { name: /database.service Database/ }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.getByRole("complementary", { name: "Unit details" })).toBeTruthy();
  await page.getByRole("button", { name: /^Dependency graph(?: |$)/, exact: true }).click();
  expect(screen.getByRole("button", { name: "Ordering" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

it("supports focused expansion, camera controls, pointer refocusing and focus return", async () => {
  await page.viewport(1280, 800);
  renderPane();
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await page.getByRole("button", { name: /^Dependency graph(?: |$)/, exact: true }).click();
  const graph = screen.getByRole("region", { name: "Systemd dependency graph" });
  await waitFor(() =>
    expect(within(graph).getByRole("button", { name: /^database.service/ })).toBeTruthy(),
  );
  expect(document.querySelectorAll(".systemd-edge-badge, .systemd-edges rect")).toHaveLength(0);
  expect(document.querySelectorAll(".systemd-edges text")).toHaveLength(0);
  const node = within(graph).getByRole("button", { name: /^database.service/ });
  await settleMotion();
  await page.getByRole("button", { name: "Expand database.service" }).click();
  await waitFor(() =>
    expect(within(graph).getByRole("button", { name: /^storage.target/ })).toBeTruthy(),
  );
  await settleMotion();
  // Slow runners can start the refit camera after the expansion settles.
  await waitFor(
    () => {
      const bounds = graph.getBoundingClientRect();
      for (const card of graph.querySelectorAll(".systemd-graph-node")) {
        const box = card.getBoundingClientRect();
        expect(box.left).toBeGreaterThanOrEqual(bounds.left - 1);
        expect(box.right).toBeLessThanOrEqual(bounds.right + 1);
        expect(box.top).toBeGreaterThanOrEqual(bounds.top - 1);
        expect(box.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
      }
    },
    { timeout: 3000 },
  );
  await settleMotion();
  const viewport = page.getByRole("region", { name: "Systemd dependency graph" });
  const initial = camera();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  expect(camera()).not.toBe(initial);
  await page.getByRole("button", { name: "Fit to view" }).click();
  const beforePan = camera();
  await userEvent.dragAndDrop(viewport, viewport, {
    sourcePosition: { x: 20, y: 80 },
    targetPosition: { x: 75, y: 100 },
  });
  expect(camera()).not.toBe(beforePan);
  node.focus();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("complementary", { name: "Unit details" })).toBeTruthy();
  const panel = screen.getByRole("complementary", { name: "Unit details" });
  const panelBox = panel.getBoundingClientRect();
  const canvasBox = graph.getBoundingClientRect();
  expect(
    Math.abs(panelBox.top + panelBox.height / 2 - canvasBox.top - canvasBox.height / 2),
  ).toBeLessThan(1);
  expect(getComputedStyle(panel).animationDelay).toBe("0s");
  const entrance = panel
    .getAnimations()
    .find(
      (animation) => (animation as CSSAnimation).animationName === "systemd-graph-inspector-in",
    )!;
  expect(entrance).toBeTruthy();
  const effect = entrance.effect as KeyframeEffect;
  expect(Number(effect.getTiming().duration)).toBe(160);
  expect(Number(effect.getKeyframes()[0].opacity)).toBeGreaterThanOrEqual(0.65);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement?.textContent).toContain("database.service"));
  await page.getByRole("button", { name: /^database.service/ }).dblClick();
  expect(screen.getByTitle("Refocus on current unit").textContent).toBe("database.service");
  expect(screen.queryByRole("complementary")).toBeNull();
});

it("switches dependency graph inspection with arrows from a node or inspector", async () => {
  await page.viewport(1280, 800);
  render(<RoutingFixture />);
  const nodes = [
    ...document.querySelectorAll<HTMLButtonElement>(".systemd-graph-node > .arch-chip"),
  ];
  nodes[0].focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(nodes[1].getAttribute("aria-pressed")).toBe("true");
  const inspector = screen.getByRole("complementary");
  expect(document.activeElement).toBe(inspector);
  await userEvent.keyboard("{ArrowUp}");
  expect(nodes[2].getAttribute("aria-pressed")).toBe("true");
  await userEvent.keyboard("{ArrowDown}");
  expect(nodes[1].getAttribute("aria-pressed")).toBe("true");
  await userEvent.keyboard("{ArrowLeft}");
  expect(nodes[0].getAttribute("aria-pressed")).toBe("true");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(nodes[0]));
});

function RoutingFixture({ cycle = false }: { cycle?: boolean }) {
  const ids = ["a.service", "b.service", "c.service", "d.service"];
  const edges = systemdEdges([
    systemdInspection(ids[0], {
      Requires: "b.service c.service",
      Wants: "b.service",
      RequiredBy: "d.service",
    }),
    ...(cycle ? [systemdInspection("b.service", { Wants: "c.service a.service" })] : []),
  ]);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div style={{ position: "relative", width: "100%", height: 700 }}>
      <SystemdGraph
        ids={ids}
        edges={edges}
        units={units}
        rootId={ids[0]}
        selectedId={selected}
        expanded={[]}
        onSelect={setSelected}
        onRefocus={() => setSelected(null)}
        onExpand={vi.fn()}
        inspector={
          <header>
            <h2>Selected</h2>
          </header>
        }
      />
    </div>
  );
}

it.each([false, true])(
  "routes consolidated edges outside unit cards with cycle=%s",
  async (cycle) => {
    await page.viewport(1280, 800);
    render(<RoutingFixture cycle={cycle} />);
    const boxes = [...document.querySelectorAll<HTMLElement>(".systemd-graph-node")].map(
      (node) => ({
        x: node.offsetLeft,
        y: node.offsetTop,
        width: node.offsetWidth,
        height: node.offsetHeight,
      }),
    );
    const blocked: string[] = [];
    for (const path of document.querySelectorAll<SVGPathElement>(".systemd-edge-path"))
      for (let distance = 0; distance <= path.getTotalLength(); distance += 6) {
        const point = path.getPointAtLength(distance);
        if (
          boxes.some(
            (box) =>
              point.x > box.x &&
              point.x < box.x + box.width &&
              point.y > box.y &&
              point.y < box.y + box.height,
          )
        ) {
          blocked.push(path.getAttribute("d")!);
          break;
        }
      }
    expect(blocked).toEqual([]);
    expect(document.querySelectorAll(".systemd-edges rect")).toHaveLength(0);
    const edge = screen
      .getAllByRole("img")
      .find((element) => element.getAttribute("aria-label")?.includes("Requires"))!;
    edge.focus();
    await waitFor(() => expect(document.querySelectorAll(".edge-active")).toHaveLength(1));
    expect(document.querySelectorAll(".systemd-edges text")).toHaveLength(0);
    expect(edge.getAttribute("aria-label")).toContain("Requires");
  },
);

it.each([360, 960, 1400])(
  "keeps a quiet explorer and compact inspector accessible at %s px",
  async (width) => {
    await page.viewport(width, 800);
    renderPane();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect((await audit()).violations).toEqual([]);
    const row = screen.getByRole("button", { name: /worker.service Queue worker/ });
    await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
    const inspector = screen.getByRole("complementary");
    const marker = document.querySelector<HTMLElement>(".systemd-selection-indicator")!;
    expect(document.activeElement).toBe(inspector);
    expect(getComputedStyle(inspector).outlineStyle).toBe("none");
    await userEvent.keyboard(tabKey);
    const close = within(inspector).getByRole("button", { name: "Close details" });
    expect(document.activeElement).toBe(close);
    expect(getComputedStyle(close).outlineStyle).toBe("solid");
    expect(getComputedStyle(marker).borderTopStyle).toBe("solid");
    expect(getComputedStyle(marker).borderTopWidth).toBe("1px");
    expect(getComputedStyle(row, "::before").content).toBe("none");
    const entrance = inspector
      .getAnimations()
      .find((animation) => (animation as CSSAnimation).animationName === "systemd-inspector-in")!;
    expect(entrance).toBeTruthy();
    const effect = entrance.effect as KeyframeEffect;
    const first = effect.getKeyframes()[0];
    expect(new DOMMatrix(String(first.transform)).m41).toBeGreaterThanOrEqual(32);
    expect(Number(effect.getTiming().duration)).toBeGreaterThanOrEqual(220);
    expect(inspector.getBoundingClientRect().width).toBeLessThanOrEqual(
      Math.min(400, width - 24) + 0.1,
    );
    if (width >= 960) expect(inspector.getBoundingClientRect().width).toBeCloseTo(400, 2);
    expect(inspector.getBoundingClientRect().height).toBeLessThan(450);
    expect(screen.queryByText("Condition passed")).toBeNull();
    expect(inspector.querySelectorAll("details[open]")).toHaveLength(0);
    expect((await audit()).violations).toEqual([]);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.getByText("Advanced", { exact: true }).click();
    await page.viewport(width, 500);
    const body = inspector.querySelector<HTMLElement>(".port-inspector-body")!;
    await waitFor(() => expect(body.scrollHeight).toBeGreaterThan(body.clientHeight));
    expect(inspector.getBoundingClientRect().bottom).toBeLessThanOrEqual(500);
    body.scrollTop = body.scrollHeight;
    expect(body.scrollTop).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Close details" }).click();
    const exiting = document.querySelector<HTMLElement>("[data-leaving] > .systemd-inspector")!;
    expect(exiting).toBeTruthy();
    expect(getComputedStyle(exiting).animationName).toBe("systemd-slide-out");
    expect(exiting.parentElement?.hasAttribute("inert")).toBe(true);
    await waitFor(() =>
      expect(document.querySelector("[data-leaving] > .systemd-inspector")).toBeNull(),
    );
    await page.viewport(width, 800);
    await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
    await page.getByRole("button", { name: /^Dependency graph(?: |$)/, exact: true }).click();
    await waitFor(() =>
      expect(document.querySelectorAll(".systemd-graph-node").length).toBeGreaterThan(1),
    );
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(Number(screen.getByText(/%$/).textContent?.replace("%", ""))).toBeGreaterThanOrEqual(85);
    expect((await audit()).violations).toEqual([]);
    const viewport = page.getByRole("region", { name: "Systemd dependency graph" });
    viewport.element().querySelector<HTMLButtonElement>(".arch-chip")!.focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByRole("complementary")).toBeTruthy();
    const plot = viewport.element().getBoundingClientRect();
    const footer = document.querySelector(".systemd-graph-footer")!.getBoundingClientRect();
    const key = screen.getByLabelText("Arrow direction").getBoundingClientRect();
    const controls = screen
      .getByRole("toolbar", { name: "Graph controls" })
      .getBoundingClientRect();
    expect(plot.bottom).toBeLessThanOrEqual(footer.top + 1);
    expect(key.top).toBeGreaterThanOrEqual(footer.top);
    expect(key.bottom).toBeLessThanOrEqual(footer.bottom);
    expect(controls.top).toBeGreaterThanOrEqual(footer.top);
    expect(controls.bottom).toBeLessThanOrEqual(footer.bottom);
    expect(key.right <= controls.left || key.bottom <= controls.top).toBe(true);
    expect(screen.getByRole("complementary").getBoundingClientRect().bottom).toBeLessThanOrEqual(
      footer.top,
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  },
);

it("keeps the inspected relationship node framed when the viewport resizes", async () => {
  await page.viewport(1280, 800);
  render(
    <div className="systemd-page">
      <RoutingFixture />
    </div>,
  );
  await page.getByRole("button", { name: /^b.service/ }).click();
  await settleMotion();
  const scale = new DOMMatrix(camera()).a;
  await page.viewport(1100, 800);
  await waitFor(() => {
    const node = screen.getByRole("button", { name: /^b.service/ }).getBoundingClientRect();
    const viewport = screen
      .getByRole("region", { name: "Systemd dependency graph" })
      .getBoundingClientRect();
    const inspector = screen.getByRole("complementary").getBoundingClientRect();
    expect(node.left).toBeGreaterThanOrEqual(viewport.left);
    expect(node.right).toBeLessThanOrEqual(inspector.left);
    expect(new DOMMatrix(camera()).a).toBeCloseTo(scale);
  });
});
