import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import axe from "axe-core";
import { ServicesPane } from "./ServicesPane";
import { useState } from "react";
import { SystemdGraph } from "../components/SystemdGraph";
import { systemdEdges } from "../lib/systemd-units";
import { ConnectionSection } from "../components/ResizablePanels";
import { connection } from "../test/app-fixtures";
import { systemdInspection } from "../test/systemd-fixtures";
import { invalidateSystemdReads } from "../lib/systemd-inspection";
import type { SystemdUnit } from "../types";
import "../styles.css";

const api = vi.hoisted(() => ({ listServices: vi.fn(), inspectSystemdUnit: vi.fn() }));
vi.mock("../lib/api", () => ({ api, errorMessage: String }));
const host = connection();
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
        section === "journal"
          ? "2026-11-01T10:00:00+0000 worker: Main process exited, status=1/FAILURE"
          : "[Service]\nRestart=on-failure",
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
        onOpenBoot={vi.fn()}
      />
    </ConnectionSection>,
  );
}
async function settleMotion() {
  await waitFor(() =>
    expect(
      document.getAnimations().filter((animation) => animation.playState === "running"),
    ).toHaveLength(0),
  );
}
async function audit() {
  await settleMotion();
  return axe.run(document.querySelector(".systemd-page")!);
}
function camera() {
  return document.querySelector<HTMLElement>(".systemd-graph-content")!.style.transform;
}

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
  await page.getByRole("button", { name: "Explore worker.service" }).click();
  const count = () => document.querySelectorAll(".systemd-graph-node").length;
  await waitFor(() => expect(count()).toBe(7));
  await page.getByRole("button", { name: /Show more/ }).click();
  expect(count()).toBe(13);
  await page.getByRole("button", { name: "Show less" }).click();
  expect(count()).toBe(7);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
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
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const ghost = document.querySelector<HTMLElement>(
      '.systemd-graph-ghost[data-unit="leaf.service"]',
    )!;
    expect(ghost).toBeTruthy();
    expect(getComputedStyle(ghost.parentElement!).animationName).toBe("systemd-node-out");
    expect(ghost.closest("[inert][aria-hidden=true]")).toBeTruthy();
  }
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(count()).toBe(14);
  expect(document.querySelector('.systemd-graph-ghost[data-unit="leaf.service"]')).toBeNull();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(count()).toBe(13);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(count()).toBe(7);
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByTitle("Refocus on current unit")),
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
  await page.getByRole("button", { name: "Explore worker.service" }).click();
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
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  expect(
    (screen.getByRole("button", { name: "Explore selected unit" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(document.querySelectorAll(".systemd-inventory .selected-row")).toHaveLength(0);
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await page.getByRole("button", { name: /^Explore /, exact: true }).click();
  const group = screen.getByRole("group", { name: "Relationship category" });
  expect(getComputedStyle(group).animationName).toBe(reduced ? "none" : "systemd-controls-in");
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  expect(screen.queryByRole("group", { name: "Relationship category" })).toBeNull();
  if (!reduced) {
    expect(group.parentElement?.hasAttribute("inert")).toBe(true);
    expect(getComputedStyle(group).animationName).toBe("systemd-slide-out");
  }
  await page.getByRole("button", { name: "Filter and sort units" }).click();
  const panel = screen.getByRole("region", { name: "Unit filters" });
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Unit filters" })).toBeNull();
  if (!reduced) expect(panel.parentElement?.hasAttribute("inert")).toBe(true);
  await waitFor(() => expect(document.querySelectorAll("[data-leaving]")).toHaveLength(0));
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  expect(screen.getAllByRole("button", { name: /^Explore / })).toHaveLength(1);
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

it("opens graph without an inspector, separates categories and keeps selection across view changes", async () => {
  await page.viewport(1280, 800);
  renderPane();
  await page.getByRole("button", { name: /database.service Database/ }).click();
  expect(screen.getByRole("heading", { name: "database.service" })).toBeTruthy();
  await page.getByRole("button", { name: /database.service Database/ }).dblClick();
  expect(screen.queryByRole("region", { name: "Systemd dependency graph" })).toBeNull();
  await page.getByRole("button", { name: "Close details" }).click();
  expect(screen.queryByRole("region", { name: "Systemd dependency graph" })).toBeNull();
  expect(screen.getByRole("button", { name: "Explore database.service" }).textContent).toContain(
    "database.service",
  );
  await page.getByRole("button", { name: /^Explore /, exact: true }).click();
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
  expect(screen.queryByRole("complementary")).toBeNull();
  await page.getByRole("button", { name: /^Explore /, exact: true }).click();
  expect(screen.getByRole("button", { name: "Ordering" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

it("supports focused expansion, camera controls, pointer refocusing and focus return", async () => {
  await page.viewport(1280, 800);
  renderPane();
  await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
  await page.getByRole("button", { name: /^Explore /, exact: true }).click();
  const graph = screen.getByRole("region", { name: "Systemd dependency graph" });
  await waitFor(() =>
    expect(within(graph).getByRole("button", { name: /^database.service/ })).toBeTruthy(),
  );
  expect(document.querySelectorAll(".systemd-edge-badge, .systemd-edges rect")).toHaveLength(0);
  expect(document.querySelectorAll(".systemd-edges text")).toHaveLength(0);
  const node = within(graph).getByRole("button", { name: /^database.service/ });
  await settleMotion();
  const before = node.getBoundingClientRect();
  await page.getByRole("button", { name: "Expand database.service" }).click();
  await waitFor(() =>
    expect(within(graph).getByRole("button", { name: /^storage.target/ })).toBeTruthy(),
  );
  await settleMotion();
  const after = node.getBoundingClientRect();
  expect(Math.abs(before.left - after.left)).toBeLessThan(1);
  expect(Math.abs(before.top - after.top)).toBeLessThan(1);
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
  const canvasBox = panel.closest(".systemd-canvas")!.getBoundingClientRect();
  expect(
    Math.abs(panelBox.top + panelBox.height / 2 - canvasBox.top - canvasBox.height / 2),
  ).toBeLessThan(1);
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
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
  }
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement?.textContent).toContain("database.service"));
  await page.getByRole("button", { name: /^database.service/ }).dblClick();
  expect(screen.getByTitle("Refocus on current unit").textContent).toBe("database.service");
  expect(screen.queryByRole("complementary")).toBeNull();
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
    expect(getComputedStyle(row).outlineStyle).toBe("solid");
    expect(getComputedStyle(row).outlineWidth).toBe("1px");
    expect(getComputedStyle(row, "::before").content).toBe("none");
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const entrance = inspector
        .getAnimations()
        .find((animation) => (animation as CSSAnimation).animationName === "systemd-inspector-in")!;
      expect(entrance).toBeTruthy();
      const effect = entrance.effect as KeyframeEffect;
      const first = effect.getKeyframes()[0];
      expect(new DOMMatrix(String(first.transform)).m41).toBeGreaterThanOrEqual(32);
      expect(Number(effect.getTiming().duration)).toBeGreaterThanOrEqual(220);
    }
    expect(inspector.getBoundingClientRect().width).toBeLessThanOrEqual(320);
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
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const exiting = document.querySelector<HTMLElement>("[data-leaving] > .systemd-inspector")!;
      expect(exiting).toBeTruthy();
      expect(getComputedStyle(exiting).animationName).toBe("systemd-slide-out");
      expect(exiting.parentElement?.hasAttribute("inert")).toBe(true);
      await waitFor(() =>
        expect(document.querySelector("[data-leaving] > .systemd-inspector")).toBeNull(),
      );
    }
    await page.viewport(width, 800);
    await page.getByRole("button", { name: /^Explore /, exact: true }).click();
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
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  },
);
