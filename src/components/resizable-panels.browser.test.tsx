import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import axe from "axe-core";
import { Plus } from "lucide-react";
import { ConnectionSection, PanelLayoutContext, ResizeDivider } from "./ResizablePanels";
import { OverviewPane } from "../pages/OverviewPane";
import { DockerPane } from "../pages/DockerPane";
import { PortsPane } from "../pages/PortsPane";
import { clampPanelSize, type PanelSizes } from "../lib/panel-layout";
import type {
  CachedList,
  DockerContainer,
  DockerContainerDetails,
  HostCapabilities,
  ListeningSocket,
  SavedConnection,
} from "../types";
import "../styles.css";

vi.mock("../lib/api", () => ({
  api: {
    cachedCapabilities: vi.fn(() => Promise.resolve(capabilities())),
    sampleHostResources: vi.fn(() =>
      Promise.resolve({
        cpuPercent: 10,
        memoryTotalKib: 1024,
        memoryAvailableKib: 500,
        sampledAt: new Date().toISOString(),
      }),
    ),
    inspectContainer: vi.fn(() => Promise.resolve(details)),
    inspectFirewall: vi.fn(() => Promise.resolve(null)),
  },
  errorMessage: String,
}));
const id = "a".repeat(64);
const connection: SavedConnection = {
  id: "connection-id",
  displayName: "Host",
  destination: "host",
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: false,
  sudoEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};
const container: DockerContainer = {
  id,
  name: "gateway-1",
  image: "gateway:latest",
  state: "running",
  status: "Up",
  ports: "",
  createdAt: "today",
  composeProject: null,
  composeService: null,
  composeContainerNumber: null,
  composeOneoff: null,
};
const details: DockerContainerDetails = {
  id,
  name: "gateway-1",
  imageReference: "gateway:latest",
  imageContentId: "sha256:abc",
  state: "running",
  running: true,
  paused: false,
  restarting: false,
  oomKilled: false,
  dead: false,
  exitCode: 0,
  startedAt: null,
  finishedAt: null,
  healthStatus: null,
  failingStreak: null,
  restartPolicy: "no",
  restartMaximumRetryCount: 0,
  publishedPorts: [],
  networks: [],
  mounts: [],
  composeProject: null,
  composeService: null,
  composeContainerNumber: null,
  composeOneoff: null,
};

function capabilities(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    connectionId: "connection-a",
    hostname: "production-server-with-a-long-hostname.example.invalid",
    osId: "debian",
    osName: "Debian GNU/Linux",
    osVersion: "12",
    kernel: "6.1.0-51-amd64-" + "long".repeat(20),
    architecture: "x86_64",
    uptime: "up 1 week, 2 days, 2 hours, 55 minutes",
    defaultShell: "/bin/bash",
    systemdAvailable: true,
    journaldAvailable: true,
    dockerAvailable: true,
    dockerAccessible: true,
    dockerAccessibleWithSudo: false,
    passwordlessSudo: false,
    dockerVersion: "29.6.2",
    runningServiceCount: 20,
    runningContainerCount: 0,
    totalContainerCount: 0,
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

const sockets: CachedList<ListeningSocket> = {
  items: [
    {
      id: "tcp:0.0.0.0:443:0",
      protocol: "tcp",
      addressFamily: "ipv4",
      localAddress: "0.0.0.0",
      port: 443,
      processName: "nginx",
      processId: 742,
      systemdUnit: "nginx.service",
      ownership: "known",
    },
  ],
  fetchedAt: Date.now(),
  loading: false,
  error: null,
};

let root: Root | null = null;
let mountNode: HTMLDivElement | null = null;
afterEach(() => {
  root?.unmount();
  mountNode?.remove();
  root = null;
  mountNode = null;
});

function Fixture() {
  const [sizes, setSizes] = useState<PanelSizes>({});
  const [section, setSection] = useState("overview");
  const setSize = (key: string, size: number | null) =>
    setSizes((current) => {
      const next = { ...current };
      if (size === null) delete next[key];
      else next[key] = size;
      return next;
    });
  const rail = clampPanelSize(sizes.connections ?? 244, 200, 480);
  return (
    <PanelLayoutContext.Provider value={{ sizes, setSize }}>
      <div
        className="app-shell"
        style={{ height: "100vh", gridTemplateColumns: `${rail}px minmax(0, 1fr)` }}
      >
        <aside className="sidebar">
          <button onClick={() => setSizes({})}>Reset layout</button>
          {["overview", "docker", "ports"].map((name) => (
            <button key={name} onClick={() => setSection(name)}>
              Open {name}
            </button>
          ))}
          <div className="sidebar-footer">
            <button className="sidebar-secondary">Local terminal</button>
            <button className="sidebar-primary">
              <Plus size={16} /> Add connection
            </button>
          </div>
          <ResizeDivider
            label="Resize Connections panel"
            className="connections-divider"
            value={rail}
            min={200}
            max={480}
            onChange={(next) => setSize("connections", next)}
            onReset={() => setSize("connections", null)}
          />
        </aside>
        <header className="app-bar" />
        <main className="workspace-shell">
          <div className="workspace-content">
            <ConnectionSection section={section}>
              {section === "overview" && <OverviewPane connection={connection} />}
              {section === "docker" && (
                <DockerPane
                  connection={connection}
                  cache={{ items: [container], fetchedAt: Date.now(), loading: false, error: null }}
                  detailsCache={{
                    [id]: { value: details, fetchedAt: Date.now(), loading: false, error: null },
                  }}
                  onCacheChange={() => undefined}
                  onDetailsCacheChange={() => undefined}
                  onViewLogs={() => undefined}
                />
              )}
              {section === "ports" && (
                <PortsPane
                  connection={connection}
                  capabilities={capabilities()}
                  globalSudoEnabled={false}
                  cache={sockets}
                  containersCache={{
                    items: [],
                    fetchedAt: Date.now(),
                    loading: false,
                    error: null,
                  }}
                  onCacheChange={() => undefined}
                  onContainersCacheChange={() => undefined}
                  onOpenSystemd={() => undefined}
                  onOpenContainer={() => undefined}
                  onViewLogs={() => undefined}
                />
              )}
            </ConnectionSection>
          </div>
        </main>
      </div>
    </PanelLayoutContext.Provider>
  );
}
function mount() {
  mountNode = document.createElement("div");
  document.body.append(mountNode);
  root = createRoot(mountNode);
  root.render(<Fixture />);
}
function assertNoHorizontalOverflow(selector: string) {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    expect(element.scrollWidth, element.className).toBeLessThanOrEqual(element.clientWidth + 1);
  }
}

describe("resizable connection panels in Chromium", () => {
  it("drags the Connections divider and supports limits, keyboard access, and reset", async () => {
    await page.viewport(960, 640);
    mount();
    const divider = page.getByRole("separator", { name: "Resize Connections panel" });
    await expect.element(divider).toHaveAttribute("aria-valuenow", "244");
    await userEvent.dragAndDrop(divider, page.getByRole("main"), {
      targetPosition: { x: 120, y: 150 },
    });
    await vi.waitFor(() =>
      expect(Number(divider.element().getAttribute("aria-valuenow"))).toBeGreaterThan(300),
    );
    expect(document.querySelector(".sidebar")!.getBoundingClientRect().width).toBeGreaterThan(300);
    await divider.click();
    await userEvent.keyboard("{End}");
    await expect.element(divider).toHaveAttribute("aria-valuenow", "480");
    await userEvent.keyboard("{Home}");
    await expect.element(divider).toHaveAttribute("aria-valuenow", "200");
    const rail = document.querySelector(".sidebar")!.getBoundingClientRect();
    for (const button of document.querySelectorAll<HTMLElement>(".sidebar-footer button")) {
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(rail.right);
      expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
    }
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(divider).toHaveAttribute("aria-valuenow", "210");
    await userEvent.keyboard("{Enter}");
    await expect.element(divider).toHaveAttribute("aria-valuenow", "244");
    const result = await axe.run(mountNode!, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    expect(result.violations.map(({ id }) => id)).toEqual([]);
  });

  it("resizes Overview content and reflows long host facts without horizontal overflow", async () => {
    await page.viewport(1280, 900);
    mount();
    const divider = page.getByRole("separator", { name: "Resize Overview content" });
    await expect
      .element(page.getByRole("heading", { name: "Overview", exact: true }))
      .toBeVisible();
    await userEvent.dragAndDrop(divider, page.getByRole("main"), {
      targetPosition: { x: 500, y: 100 },
    });
    await vi.waitFor(() =>
      expect(Number(divider.element().getAttribute("aria-valuenow"))).toBeLessThan(600),
    );
    await divider.click();
    await userEvent.keyboard("{Home}");
    await expect.element(divider).toHaveAttribute("aria-valuenow", "360");
    assertNoHorizontalOverflow(
      ".overview-page, .definition-grid, .resource-meter, .capability-row",
    );
    const rows = document.querySelectorAll(".definition-grid > div");
    expect(rows[1].getBoundingClientRect().top).toBeGreaterThan(
      rows[0].getBoundingClientRect().bottom - 1,
    );
    await page.getByRole("button", { name: "Reset layout", exact: true }).click();
    await vi.waitFor(() =>
      expect(Number(divider.element().getAttribute("aria-valuenow"))).toBeGreaterThan(1000),
    );
  });

  it("drags Docker panes, preserves per-section sizes, and stacks them in a narrow section", async () => {
    await page.viewport(1280, 900);
    mount();
    await page.getByRole("button", { name: "Open docker" }).click();
    const split = page.getByRole("separator", { name: "Resize Docker panes" });
    await expect.element(split).toBeVisible();
    const initial = Number(split.element().getAttribute("aria-valuenow"));
    await userEvent.dragAndDrop(split, page.getByRole("main"), {
      targetPosition: { x: 300, y: 150 },
    });
    await vi.waitFor(() =>
      expect(Number(split.element().getAttribute("aria-valuenow"))).toBeLessThan(initial - 100),
    );
    const chosen = split.element().getAttribute("aria-valuenow");
    const detail = document.querySelector(".detail-panel")!.getBoundingClientRect();
    const list = document.querySelector(".list-panel")!.getBoundingClientRect();
    expect(detail.left).toBeGreaterThanOrEqual(list.right - 1);
    const content = page.getByRole("separator", { name: "Resize Docker content" });
    await content.click();
    await userEvent.keyboard("{Home}");
    await expect.element(split).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(
        document.querySelector(".detail-panel")!.getBoundingClientRect().top,
      ).toBeGreaterThanOrEqual(
        document.querySelector(".list-panel")!.getBoundingClientRect().bottom - 1,
      ),
    );
    assertNoHorizontalOverflow(".list-panel, .detail-panel");
    await userEvent.dblClick(content);
    await expect.element(split).toHaveAttribute("aria-valuenow", chosen!);
    await page.getByRole("button", { name: "Open overview" }).click();
    await page.getByRole("button", { name: "Open docker" }).click();
    await expect.element(split).toHaveAttribute("aria-valuenow", chosen!);
  });

  it("fits the Ports graph after pane resizing and keeps filters usable at the minimum window", async () => {
    await page.viewport(960, 640);
    mount();
    await page.getByRole("button", { name: "Open ports" }).click();
    const content = page.getByRole("separator", { name: "Resize Ports content" });
    await expect
      .element(page.getByRole("separator", { name: "Resize Ports overview panes" }))
      .toBeVisible();
    await content.click();
    await userEvent.keyboard("{Home}");
    await expect
      .element(page.getByRole("separator", { name: "Resize Ports overview panes" }))
      .not.toBeInTheDocument();
    await vi.waitFor(() => {
      const canvas = document.querySelector(".arch-viewport")!.getBoundingClientRect();
      const graph = document.querySelector(".arch-content")!.getBoundingClientRect();
      expect(graph.right).toBeLessThanOrEqual(canvas.right + 1);
    });
    assertNoHorizontalOverflow(".ports-page, .port-list-controls, .arch-detail");
    await page.getByRole("tab", { name: "Table", exact: true }).click();
    await expect.element(page.getByRole("combobox", { name: "Sort ports" })).toBeVisible();
    assertNoHorizontalOverflow(".list-panel, .detail-panel");
  });
});
