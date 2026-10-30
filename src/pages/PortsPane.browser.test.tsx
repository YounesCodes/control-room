import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { TooltipLayer } from "../components/TooltipLayer";
import "../styles.css";
import { afterEach, expect, it, vi } from "vitest";
import type {
  CachedList,
  DockerContainer,
  HostCapabilities,
  ListeningSocket,
  SavedConnection,
} from "../types";
import { PortsPane } from "./PortsPane";

vi.mock("../lib/api", () => ({
  api: {
    listPorts: vi.fn(),
    listContainers: vi.fn(),
    inspectFirewall: vi.fn().mockResolvedValue({
      backend: "ufw",
      available: true,
      active: true,
      defaultIncoming: "deny",
      rules: [
        {
          to: "443/tcp",
          action: "ALLOW",
          from: "Anywhere",
          port: 443,
          protocol: "tcp",
          ipv6: false,
        },
      ],
      collectedAt: "",
    }),
    inspectConnections: vi.fn().mockResolvedValue({
      groups: [
        {
          key: "tcp:443:nginx.service",
          protocol: "tcp",
          localPort: 443,
          processName: "nginx",
          processId: 742,
          systemdUnit: "nginx.service",
          established: 12,
          remoteAddressCount: 3,
          remotes: [{ address: "203.0.113.9", count: 8 }],
        },
      ],
      totalEstablished: 12,
      truncated: false,
      collectedAt: "",
    }),
  },
  errorMessage: (error: unknown) => String(error),
}));

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

const containers: CachedList<DockerContainer> = {
  items: [
    {
      id: "container-id",
      name: "gateway-1",
      image: "gateway:latest",
      state: "running",
      status: "Up",
      ports: "0.0.0.0:443->8443/tcp",
      createdAt: "today",
      composeProject: "proxy",
      composeService: "gateway",
      composeContainerNumber: 1,
      composeOneoff: false,
    },
  ],
  fetchedAt: Date.now(),
  loading: false,
  error: null,
};

function renderPane(
  capabilities: HostCapabilities | null = null,
  cache = sockets,
  containersCache = containers,
) {
  const onOpenSystemd = vi.fn();
  const onOpenContainer = vi.fn();
  const onViewLogs = vi.fn();
  const result = render(
    <PortsPane
      connection={connection}
      capabilities={capabilities}
      globalSudoEnabled={false}
      cache={cache}
      containersCache={containersCache}
      onCacheChange={vi.fn()}
      onContainersCacheChange={vi.fn()}
      onOpenSystemd={onOpenSystemd}
      onOpenContainer={onOpenContainer}
      onViewLogs={onViewLogs}
    />,
  );
  return { onOpenSystemd, onOpenContainer, onViewLogs, ...result };
}

afterEach(cleanup);

function camera() {
  return new DOMMatrix(getComputedStyle(document.querySelector(".arch-content")!).transform);
}

function expectNodeBesideInspector(node: Element) {
  const bounds = node.getBoundingClientRect();
  const inspector = screen.getByRole("complementary").getBoundingClientRect();
  const viewport = screen.getByRole("region", { name: "Ports graph" }).getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(viewport.left + 20);
  expect(bounds.right).toBeLessThan(inspector.left - 12);
  expect(bounds.top).toBeGreaterThan(viewport.top + 70);
  expect(bounds.bottom).toBeLessThan(viewport.bottom - 54);
}

it("anchors snapshot help to the count instead of the toolbar edge", async () => {
  await page.viewport(1100, 760);
  renderPane();
  render(<TooltipLayer />);
  await screen.findByRole("button", { name: /12 established/ });
  const summary = document.querySelector<HTMLElement>(".ports-snapshot-summary")!;
  summary.focus();
  await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy());
  const tooltip = screen.getByRole("tooltip").getBoundingClientRect();
  expect(Math.abs(tooltip.left - summary.getBoundingClientRect().left)).toBeLessThan(2);
  await waitFor(() =>
    expect(screen.getByRole("tooltip").getBoundingClientRect().top).toBeGreaterThanOrEqual(
      summary.getBoundingClientRect().bottom + 7,
    ),
  );
  expect(tooltip.right).toBeLessThan(window.innerWidth - 7);
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).toBeNull();
});

for (const width of [960, 1600]) {
  it(
    "frames selections beside the inspector at " + width + "px and respects reduced motion",
    async () => {
      await page.viewport(width, 760);
      renderPane();
      await screen.findByRole("button", { name: /12 established/ });
      const before = camera();
      await page.getByRole("button", { name: /443 Listening/ }).click();
      await waitFor(() => {
        expect(camera().a).toBeGreaterThan(before.a);
        expectNodeBesideInspector(screen.getByRole("button", { name: /443 Listening/ }));
      });
      const inspector = screen.getByRole("complementary");
      expect(document.activeElement).toBe(inspector);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      expect(getComputedStyle(inspector).animationName).toBe(
        reduced ? "none" : "port-inspector-in",
      );
      // Keyboard focus reveals nodes obscured by the current inspector before activation.
      screen.getByRole("button", { name: /12 established/ }).focus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() =>
        expectNodeBesideInspector(screen.getByRole("button", { name: /12 established/ })),
      );
      expect(within(screen.getByRole("complementary")).getByText("203.0.113.9")).toBeTruthy();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("complementary")).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /12 established/ }));
      await page.getByRole("button", { name: "Fit to view" }).click();
      expect(camera().a).toBeCloseTo(before.a);
    },
  );
}

it("uses a compact filter header and visible labels without an empty footer", async () => {
  await page.viewport(960, 640);
  renderPane();
  await screen.findByRole("button", { name: /12 established/ });
  await page.getByRole("button", { name: "Filter ports" }).click();
  const panel = screen.getByRole("region", { name: "Port filters" });
  const heading = within(panel).getByText("Filters").closest("header")!;
  expect(heading.contains(screen.getByRole("button", { name: "Reset filters" }))).toBe(true);
  expect(heading.contains(screen.getByRole("button", { name: "Close port tools" }))).toBe(true);
  for (const label of ["Show", "Protocol", "Exposure", "Sort by"]) {
    expect(
      within(panel)
        .getByText(label, { selector: "label > span" })
        .closest("label")
        ?.querySelector("select"),
    ).toBeTruthy();
  }
  expect(panel.querySelector("footer")).toBeNull();
  expect(panel.getBoundingClientRect().height).toBeLessThan(220);
});

it("lets manual zoom interrupt selection motion", async () => {
  await page.viewport(1100, 760);
  renderPane();
  await screen.findByRole("button", { name: /12 established/ });
  await page.getByRole("button", { name: /443 Listening/ }).click();
  await page.getByRole("button", { name: "Zoom out" }).click();
  expect(document.querySelector(".arch-focusing")).toBeNull();
  expect(
    parseFloat(getComputedStyle(document.querySelector(".arch-content")!).transitionDuration),
  ).toBeLessThan(0.42);
});
