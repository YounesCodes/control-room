import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import axe from "axe-core";
import { ServicesPane } from "./ServicesPane";
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
function camera() {
  return document.querySelector<HTMLElement>(".systemd-graph-content")!.style.transform;
}

it("keeps a large inventory bounded and supports keyboard navigation to its last unit", async () => {
  await page.viewport(1280, 800);
  renderPane(
    Array.from({ length: 4000 }, (_, index) => ({
      ...units[1],
      id: "unit-" + String(index).padStart(4, "0") + ".service",
    })),
  );
  expect(document.querySelectorAll(".dense-row").length).toBeLessThan(50);
  const list = screen.getByRole("region", { name: "Systemd units" });
  list.focus();
  await userEvent.keyboard("{End}");
  await waitFor(() => expect(document.activeElement?.textContent).toContain("unit-3999.service"));
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("heading", { name: "unit-3999.service" })).toBeTruthy();
  expect(document.querySelectorAll(".dense-row").length).toBeLessThan(50);
  await page.getByRole("textbox", { name: "Search units", exact: true }).fill("unit-0010");
  await expect
    .element(page.getByRole("button", { name: /unit-0010.service Database/ }))
    .toBeVisible();
});

it("supports graph expansion, relationship filters, pan, zoom and keyboard refocusing", async () => {
  await page.viewport(1400, 820);
  renderPane();
  await page.getByRole("button", { name: "Dependency graph", exact: true }).click();
  const graph = screen.getByRole("region", { name: "Systemd dependency graph" });
  await waitFor(() =>
    expect(within(graph).getByRole("button", { name: /^database.service/ })).toBeTruthy(),
  );
  const initial = camera();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  expect(camera()).not.toBe(initial);
  await page.getByRole("button", { name: "Fit to view" }).click();
  expect(camera()).toBe(initial);
  await page.getByRole("button", { name: "Expand database.service" }).click();
  await waitFor(() =>
    expect(within(graph).getByRole("button", { name: /^storage.target/ })).toBeTruthy(),
  );
  await page.getByRole("button", { name: "Requires", exact: true }).click();
  expect(within(graph).queryByRole("button", { name: /^storage.target/ })).toBeNull();
  await page.getByRole("button", { name: "Requires", exact: true }).click();
  await page.getByRole("button", { name: "Close details" }).click();
  const viewport = page.getByRole("region", { name: "Systemd dependency graph" });
  const before = camera();
  await userEvent.dragAndDrop(viewport, viewport, {
    sourcePosition: { x: 15, y: 10 },
    targetPosition: { x: 70, y: 45 },
  });
  expect(camera()).not.toBe(before);
  const database = within(graph).getByRole("button", { name: /^database.service/ });
  database.focus();
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  await waitFor(() =>
    expect(screen.getByTitle("Refocus on current unit").textContent).toBe("database.service"),
  );
  expect(screen.getByRole("complementary", { name: "Unit details" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("complementary", { name: "Unit details" })).toBeNull();
  expect(document.activeElement?.textContent).toContain("database.service");
  await page.getByRole("button", { name: /^storage.target/ }).dblClick();
  await waitFor(() =>
    expect(screen.getByTitle("Refocus on current unit").textContent).toBe("storage.target"),
  );
});

it.each([360, 960, 1400])("keeps the explorer accessible at %s px", async (width) => {
  await page.viewport(width, 800);
  renderPane();
  await waitFor(() => expect(screen.getByText("exit-code")).toBeTruthy());
  expect((await axe.run(document.querySelector(".systemd-page")!)).violations).toEqual([]);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  await page.getByRole("button", { name: "Dependency graph", exact: true }).click();
  expect((await axe.run(document.querySelector(".systemd-page")!)).violations).toEqual([]);
  expect(getComputedStyle(document.querySelector(".systemd-graph-node")!).animationName).toBe(
    "none",
  );
  await page.getByRole("button", { name: "Close details" }).click();
  await page.getByRole("button", { name: "Fit to view" }).click();
  const content = document.querySelector(".systemd-graph-content")!.getBoundingClientRect();
  const viewport = screen
    .getByRole("region", { name: "Systemd dependency graph" })
    .getBoundingClientRect();
  expect(content.left).toBeGreaterThanOrEqual(viewport.left);
  expect(content.right).toBeLessThanOrEqual(viewport.right);
});

it("captures the current inventory with fictional failure evidence", async () => {
  await page.viewport(1280, 800);
  renderPane();
  await waitFor(() => expect(screen.getByText("exit-code")).toBeTruthy());
  await page.screenshot({ path: "../../test-results/systemd-inventory.png" });
  await page.getByRole("button", { name: "Dependency graph", exact: true }).click();
  await waitFor(() => expect(document.querySelectorAll(".systemd-graph-node")).toHaveLength(6));
  await page.screenshot({ path: "../../test-results/systemd-graph.png" });
});
