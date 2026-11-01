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

it("slides relationship controls and filter panels out without leaving focusable duplicates", async () => {
  await page.viewport(1280, 800);
  renderPane();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  await page.getByRole("button", { name: "Dependency graph", exact: true }).click();
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
  expect(screen.getAllByRole("button", { name: /graph/i })).toHaveLength(1);
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
  await page.getByRole("button", { name: "Dependency graph", exact: true }).click();
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
  await page.getByRole("button", { name: "Dependency graph", exact: true }).click();
  expect(screen.getByRole("button", { name: "Ordering" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

it("supports focused expansion, camera controls, pointer refocusing and focus return", async () => {
  await page.viewport(1280, 800);
  renderPane();
  await page.getByRole("button", { name: "Dependency graph", exact: true }).click();
  const graph = screen.getByRole("region", { name: "Systemd dependency graph" });
  await waitFor(() =>
    expect(within(graph).getByRole("button", { name: /^database.service/ })).toBeTruthy(),
  );
  expect(document.querySelectorAll(".systemd-edge-badge, .systemd-edges rect")).toHaveLength(0);
  expect(document.querySelectorAll(".systemd-edge-label").length).toBeGreaterThan(0);
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
    await waitFor(() =>
      expect(document.querySelectorAll(".edge-active .systemd-edge-label")).toHaveLength(1),
    );
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
    await page.getByRole("button", { name: /worker.service Queue worker/ }).click();
    const inspector = screen.getByRole("complementary");
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
    await page.getByRole("button", { name: "Dependency graph", exact: true }).click();
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
