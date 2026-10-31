import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import axe from "axe-core";
import { ConnectionSection, PanelLayoutContext } from "../components/ResizablePanels";
import { DockerPane } from "./DockerPane";
import type {
  CachedList,
  DockerContainer,
  DockerContainerDetails,
  SavedConnection,
} from "../types";
import "../styles.css";

const api = vi.hoisted(() => ({ listContainers: vi.fn(), inspectContainer: vi.fn() }));
vi.mock("../lib/api", () => ({ api, errorMessage: String }));

const connection: SavedConnection = {
  id: "sample-host",
  displayName: "Example host",
  destination: "example.invalid",
  username: "example",
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
const containers: DockerContainer[] = Array.from({ length: 12 }, (_, index) => ({
  id: (index + 1).toString(16).padStart(64, "0"),
  name: ["gateway", "worker", "database"][index % 3] + "-" + (Math.floor(index / 3) + 1),
  image: ["nginx:stable", "worker:latest", "postgres:17"][index % 3],
  state: index % 3 === 1 ? "exited" : "running",
  status: index % 3 === 1 ? "Exited (0)" : "Up 2 hours",
  ports: "",
  createdAt: "2026-10-01T12:00:00Z",
  composeProject: ["edge", "monitoring", "tools", null][Math.floor(index / 3)],
  composeService: ["gateway", "worker", "database"][index % 3],
  composeContainerNumber: 1,
  composeOneoff: false,
}));
function details(container: DockerContainer): DockerContainerDetails {
  return {
    id: container.id,
    name: container.name,
    imageReference: container.image,
    imageContentId: "sha256:example",
    state: container.state,
    running: container.state === "running",
    paused: false,
    restarting: false,
    oomKilled: false,
    dead: false,
    exitCode: 0,
    startedAt: "2026-10-31T09:00:00Z",
    finishedAt: null,
    healthStatus: "healthy",
    failingStreak: 0,
    restartPolicy: "unless-stopped",
    restartMaximumRetryCount: 0,
    publishedPorts: [{ hostAddress: "0.0.0.0", hostPort: 443, containerPort: "8443/tcp" }],
    networks: [
      {
        name: "edge_default",
        ipv4Address: "172.20.0.2",
        ipv4Gateway: "172.20.0.1",
        ipv6Address: null,
        ipv6Gateway: null,
      },
    ],
    mounts: [
      {
        mountType: "volume",
        name: "data",
        destination: "/var/lib/data",
        writable: true,
        propagation: null,
      },
    ],
    composeProject: container.composeProject,
    composeService: container.composeService,
    composeContainerNumber: container.composeContainerNumber,
    composeOneoff: container.composeOneoff,
  };
}
const cache: CachedList<DockerContainer> = {
  items: containers,
  fetchedAt: Date.now(),
  loading: false,
  error: null,
};
function renderPane(
  focusId: string | null = null,
  items = containers,
  detailOverrides: Partial<DockerContainerDetails> = {},
) {
  const onViewLogs = vi.fn();
  const result = render(
    <PanelLayoutContext.Provider
      value={{ sizes: { "content:docker": 360, "split:Docker": 240 }, setSize: vi.fn() }}
    >
      <ConnectionSection section="docker">
        <DockerPane
          connection={connection}
          cache={{ ...cache, items }}
          detailsCache={Object.fromEntries(
            items.map((container) => [
              container.id,
              {
                value: { ...details(container), ...detailOverrides },
                fetchedAt: Date.now(),
                loading: false,
                error: null,
              },
            ]),
          )}
          onCacheChange={vi.fn()}
          onDetailsCacheChange={vi.fn()}
          onViewLogs={onViewLogs}
          focusId={focusId}
        />
      </ConnectionSection>
    </PanelLayoutContext.Provider>,
  );
  return { ...result, onViewLogs };
}
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it("aligns circular running and exited markers with their status labels", async () => {
  await page.viewport(1280, 800);
  renderPane();
  for (const state of ["running", "exited"]) {
    const marker = document.querySelector<HTMLElement>(`.docker-chip-state .service-${state}`)!;
    const label = marker.nextElementSibling!;
    const dot = marker.getBoundingClientRect();
    const text = label.getBoundingClientRect();
    expect(Math.abs(dot.top + dot.height / 2 - text.top - text.height / 2)).toBeLessThan(0.5);
    expect(dot.width).toBeCloseTo(dot.height);
    expect(getComputedStyle(marker).borderRadius).toBe("50%");
    expect(getComputedStyle(marker).transform).toBe("none");
    expect(label.textContent).toBe(state);
  }
});

it("keeps empty Docker sections compact", async () => {
  await page.viewport(960, 640);
  renderPane(containers[0].id, containers, {
    mounts: [],
    networks: [],
    publishedPorts: [],
    composeProject: null,
    composeService: null,
  });
  for (const [section, message] of [
    ["Mounts", "No mounts"],
    ["Networks", "No network attachments"],
    ["Published ports", "No published ports"],
    ["Container & Compose", "No validated Compose identity"],
  ]) {
    await page.getByText(section, { exact: true }).click();
    const empty = screen.getByText(message);
    expect(empty.getBoundingClientRect().height).toBeLessThanOrEqual(24);
    expect(empty.closest("details")!.querySelector(".panel-state")).toBeNull();
  }
});

function camera() {
  return document.querySelector<HTMLElement>(".arch-content")!.style.transform;
}
function expectEntireGraph() {
  const graph = document.querySelector(".arch-content")!.getBoundingClientRect();
  const viewport = screen.getByRole("region", { name: "Docker graph" }).getBoundingClientRect();
  const controls = document.querySelector(".ports-canvas-controls")!.getBoundingClientRect();
  expect(graph.left).toBeGreaterThanOrEqual(viewport.left + 12);
  expect(graph.right).toBeLessThanOrEqual(viewport.right - 12);
  expect(graph.top).toBeGreaterThanOrEqual(controls.bottom + 12);
  expect(graph.bottom).toBeLessThanOrEqual(viewport.bottom - 48);
}
function expectBesideInspector(node: Element) {
  const bounds = node.getBoundingClientRect();
  const inspector = screen
    .getByRole("complementary", { name: "Container details" })
    .getBoundingClientRect();
  const viewport = screen.getByRole("region", { name: "Docker graph" }).getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(viewport.left + 20);
  expect(bounds.right).toBeLessThan(inspector.left - 12);
  expect(bounds.top).toBeGreaterThan(viewport.top + 50);
  expect(bounds.bottom).toBeLessThan(viewport.bottom - 54);
}

it("fills the workspace despite saved list widths, fits on resize and resets zoom", async () => {
  await page.viewport(1280, 800);
  renderPane();
  expect(screen.queryByRole("separator", { name: /Docker/ })).toBeNull();
  expect(document.querySelectorAll(".arch-chip")).toHaveLength(12);
  expect(document.querySelectorAll(".arch-group")).toHaveLength(4);
  expect(document.querySelectorAll(".arch-links path")).toHaveLength(4);
  expect(screen.queryByRole("complementary")).toBeNull();
  await waitFor(expectEntireGraph);
  const initial = camera();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  expect(camera()).not.toBe(initial);
  await page.getByRole("button", { name: "Fit to view" }).click();
  expect(camera()).toBe(initial);
  for (const width of [960, 1600]) {
    await page.viewport(width, 760);
    await waitFor(expectEntireGraph);
  }
  expect((await axe.run(document.querySelector(".docker-page")!)).violations).toEqual([]);
});

it("centers selection, keeps it open during pan, dismisses on empty canvas and restores focus", async () => {
  await page.viewport(1280, 800);
  renderPane();
  await waitFor(expectEntireGraph);
  const initial = camera();
  const node = page.getByRole("button", { name: /gateway-1.*running/ });
  await node.click();
  await waitFor(() => expectBesideInspector(node.element()));
  expect(document.activeElement).toBe(screen.getByRole("complementary"));
  const viewport = page.getByRole("region", { name: "Docker graph" });
  const beforePan = camera();
  await userEvent.dragAndDrop(viewport, viewport, {
    sourcePosition: { x: 30, y: 125 },
    targetPosition: { x: 90, y: 150 },
  });
  expect(camera()).not.toBe(beforePan);
  expect(screen.getByRole("complementary")).toBeTruthy();
  await viewport.click({ position: { x: 20, y: 100 } });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(document.activeElement).toBe(node.element());
  await waitFor(() => expect(camera()).toBe(initial));
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("complementary")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("complementary")).toBeNull();
  await userEvent.keyboard("{Enter}");
  await page.getByRole("button", { name: "Close details" }).click();
  expect(document.activeElement).toBe(node.element());
  await userEvent.keyboard("{Enter}");
  await node.click();
  expect(screen.queryByRole("complementary")).toBeNull();
});

it("filters projects and states, clears hidden selection, and restores the grouped layout", async () => {
  await page.viewport(1280, 800);
  renderPane();
  await page.getByRole("button", { name: /gateway-1.*running/ }).click();
  await page.getByRole("button", { name: "Find containers", exact: true }).click();
  await page.getByRole("textbox", { name: "Search containers" }).fill("monitoring");
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(document.querySelectorAll(".arch-chip")).toHaveLength(3);
  await page.getByRole("button", { name: "Clear search" }).click();
  expect(document.querySelectorAll(".arch-chip")).toHaveLength(12);
  expect(screen.queryByRole("complementary")).toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Find containers" }));
  await page.getByRole("button", { name: "Filter containers" }).click();
  await page.getByRole("combobox", { name: "Container state" }).selectOptions("exited");
  expect(document.querySelectorAll(".arch-chip")).toHaveLength(4);
  await page.getByRole("combobox", { name: "Group by" }).selectOptions("none");
  expect(document.querySelectorAll(".arch-group")).toHaveLength(4);
  expect(
    (await axe.run(screen.getByRole("region", { name: "Container filters" }))).violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Reset filters" }).click();
  expect(document.querySelectorAll(".arch-chip")).toHaveLength(12);
  expect(document.querySelectorAll(".arch-group")).toHaveLength(4);
  await page.getByRole("combobox", { name: "Group by" }).selectOptions("none");
  expect(document.querySelectorAll(".arch-group")).toHaveLength(12);
});

it("frames a container opened from Ports and keeps details and logs usable at minimum width", async () => {
  await page.viewport(960, 640);
  const { onViewLogs } = renderPane(containers[0].id);
  const node = screen.getByRole("button", { name: /gateway-1.*running/ });
  await waitFor(() => expectBesideInspector(node));
  const inspector = screen.getByRole("complementary");
  const logo = within(inspector).getByRole("img", { name: "NGINX image" });
  expect(logo.closest(".container-inspector-heading")).toBeTruthy();
  expect(logo.getBoundingClientRect().width).toBe(20);
  expect(logo.getBoundingClientRect().height).toBe(20);
  for (const name of ["Published ports", "Networks", "Mounts", "Container & Compose"]) {
    await page.getByText(name, { exact: true }).click();
  }
  const body = screen.getByRole("region", { name: "Container information" });
  const header = within(inspector)
    .getByRole("heading", { name: "gateway-1" })
    .getBoundingClientRect();
  const footer = within(inspector)
    .getByRole("button", { name: "View logs" })
    .getBoundingClientRect();
  expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
  body.scrollTop = body.scrollHeight;
  expect(
    within(inspector).getByRole("heading", { name: "gateway-1" }).getBoundingClientRect().top,
  ).toBe(header.top);
  expect(
    within(inspector).getByRole("button", { name: "View logs" }).getBoundingClientRect().top,
  ).toBe(footer.top);
  expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth);
  expect((await axe.run(document.querySelector(".docker-page")!)).violations).toEqual([]);
  await page.getByRole("button", { name: "View logs" }).click();
  expect(onViewLogs).toHaveBeenCalledWith({ type: "docker", id: containers[0].id });
  await page.viewport(1600, 900);
  body.scrollTop = 0;
  await page.getByRole("button", { name: "Fit to view" }).click();
  await page.screenshot({ path: "../../test-results/docker-graph.png" });
});

it("reveals the final node with keyboard navigation without selecting it", async () => {
  await page.viewport(1100, 760);
  renderPane();
  await page.getByRole("button", { name: /gateway-1.*running/ }).click();
  await userEvent.keyboard("{Escape}");
  await userEvent.keyboard("{End}");
  const nodes = document.querySelectorAll<HTMLButtonElement>(".arch-chip");
  expect(document.activeElement).toBe(nodes[nodes.length - 1]);
  expect(screen.queryByRole("complementary")).toBeNull();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expectBesideInspector(nodes[nodes.length - 1]));
});
