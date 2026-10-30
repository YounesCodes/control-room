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
import { api } from "../lib/api";
import axe from "axe-core";
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

it("keeps snapshot metadata on Ports hover with a gap below the whole toolbar", async () => {
  await page.viewport(1100, 760);
  renderPane();
  render(<TooltipLayer />);
  await screen.findByRole("button", { name: /12 established/ });
  const summary = screen.getByRole("heading", { name: "Ports" });
  const toolbar = document.querySelector(".ports-heading")!;
  expect(toolbar.textContent).not.toContain("listener");
  expect(summary.title).toContain("1 listening port");
  expect(summary.title).toContain("Last collected at");
  await page.getByRole("heading", { name: "Ports" }).hover();
  await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy());
  const tooltip = screen.getByRole("tooltip").getBoundingClientRect();
  expect(tooltip.top).toBeGreaterThan(toolbar.getBoundingClientRect().bottom);
  expect(Math.abs(tooltip.left - summary.getBoundingClientRect().left)).toBeLessThan(2);
  await waitFor(() =>
    expect(screen.getByRole("tooltip").getBoundingClientRect().top).toBeGreaterThanOrEqual(
      toolbar.getBoundingClientRect().bottom + 7,
    ),
  );
  expect(tooltip.right).toBeLessThan(window.innerWidth - 7);
  const text = screen.getByRole("tooltip");
  expect(text.textContent?.split(String.fromCharCode(10))).toEqual([
    expect.stringMatching(/^Last collected at /),
    "1 listening port",
    "12 active connections",
  ]);
  expect(text.getBoundingClientRect().height).toBeGreaterThanOrEqual(
    parseFloat(getComputedStyle(text).lineHeight) * 3,
  );
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).toBeNull();
  summary.blur();
  summary.focus();
  await waitFor(() =>
    expect(screen.getByRole("tooltip").textContent).toContain("12 active connections"),
  );
});

for (const width of [960, 1600]) {
  it(
    "frames selections beside the inspector at " + width + "px and respects reduced motion",
    async () => {
      await page.viewport(width, 760);
      renderPane();
      await screen.findByRole("button", { name: /12 established/ });
      const before = camera();
      await page.getByRole("button", { name: /443.*Listening/ }).click();
      await waitFor(() => {
        expect(camera().a).toBeGreaterThan(before.a);
        expectNodeBesideInspector(screen.getByRole("button", { name: /443.*Listening/ }));
      });
      const inspector = screen.getByRole("complementary");
      expect(document.activeElement).toBe(inspector);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      expect(getComputedStyle(inspector).animationName).toBe(
        reduced ? "none" : "port-inspector-in",
      );
      // Related connection evidence belongs to the selected listening endpoint.
      expect(screen.getAllByRole("button", { name: /12 established/ })).toHaveLength(1);
      await page.getByText("12 established · Remote endpoints", { exact: true }).click();
      expect(within(screen.getByRole("complementary")).getByText("203.0.113.9")).toBeTruthy();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("complementary")).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /443.*Listening/ }));
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
  for (const label of ["Contents", "Protocol", "Binding scope", "Sort"]) {
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
  await page.getByRole("button", { name: /443.*Listening/ }).click();
  await page.getByRole("button", { name: "Zoom out" }).click();
  expect(document.querySelector(".arch-focusing")).toBeNull();
  expect(
    parseFloat(getComputedStyle(document.querySelector(".arch-content")!).transitionDuration),
  ).toBeLessThan(0.42);
});

for (const height of [640, 900]) {
  it("centers the inspector vertically with even canvas gutters at " + height + "px", async () => {
    await page.viewport(1100, height);
    renderPane();
    await screen.findByRole("button", { name: /12 established/ });
    await page.getByRole("button", { name: /443.*Listening/ }).click();
    const canvas = document.querySelector(".arch-canvas")!.getBoundingClientRect();
    const inspector = screen.getByRole("complementary").getBoundingClientRect();
    expect(inspector.top - canvas.top).toBeCloseTo(12, 0);
    expect(canvas.bottom - inspector.bottom).toBeCloseTo(12, 0);
    expect((inspector.top + inspector.bottom) / 2).toBeCloseTo((canvas.top + canvas.bottom) / 2, 0);
    await waitFor(() =>
      expect(
        screen.getByRole("toolbar", { name: "Graph controls" }).getBoundingClientRect().right,
      ).toBeLessThan(inspector.left),
    );
  });
}

it("slides zoom controls left on selection and right on inspector close", async () => {
  await page.viewport(1100, 760);
  renderPane();
  await screen.findByRole("button", { name: /12 established/ });
  const controls = screen.getByRole("toolbar", { name: "Graph controls" });
  const canvas = document.querySelector(".arch-canvas")!.getBoundingClientRect();
  const initial = controls.getBoundingClientRect();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  async function checkSlide(direction: "left" | "right") {
    if (!reduced) {
      const movement = controls
        .getAnimations()
        .find(
          (animation) =>
            animation instanceof CSSTransition && animation.transitionProperty === "left",
        );
      expect(movement).toBeTruthy();
      const animations = controls.getAnimations();
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = 210;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const midway = controls.getBoundingClientRect();
      expect(midway.left).toBeGreaterThan(canvas.left + 12);
      expect(midway.left).toBeLessThan(initial.left);
      for (const animation of animations) animation.finish();
    }
    await waitFor(() => {
      const bounds = controls.getBoundingClientRect();
      if (direction === "left") expect(bounds.left - canvas.left).toBeCloseTo(12, 0);
      else expect(canvas.right - bounds.right).toBeCloseTo(12, 0);
    });
  }

  await page.getByRole("button", { name: /443.*Listening/ }).click();
  await checkSlide("left");
  await page.getByRole("button", { name: "Close details" }).click();
  await checkSlide("right");
});

for (const exit of ["close", "escape", "same port", "empty canvas"] as const) {
  it("restores default framing when exiting through " + exit, async () => {
    await page.viewport(1100, 760);
    renderPane();
    await screen.findByRole("button", { name: /12 established/ });
    const initial = camera();
    const node = page.getByRole("button", { name: /443.*Listening/ });
    await node.click();
    await waitFor(() => expectNodeBesideInspector(node.element()));
    if (exit === "close") await page.getByRole("button", { name: "Close details" }).click();
    else if (exit === "escape") await userEvent.keyboard("{Escape}");
    else if (exit === "same port") await node.click();
    else
      await page
        .getByRole("region", { name: "Ports graph" })
        .click({ position: { x: 20, y: 120 } });
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(node.element().getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => {
      const restored = camera();
      expect(restored.a).toBeCloseTo(initial.a, 3);
      expect(restored.e).toBeCloseTo(initial.e, 1);
      expect(restored.f).toBeCloseTo(initial.f, 1);
    });
  });
}

it("keeps the inspector open while dragging empty canvas space", async () => {
  await page.viewport(1100, 760);
  renderPane();
  await screen.findByRole("button", { name: /12 established/ });
  const node = page.getByRole("button", { name: /443.*Listening/ });
  await node.click();
  await waitFor(() => expectNodeBesideInspector(node.element()));
  const viewport = page.getByRole("region", { name: "Ports graph" });
  const before = camera();
  await userEvent.dragAndDrop(viewport, viewport, {
    sourcePosition: { x: 20, y: 120 },
    targetPosition: { x: 100, y: 160 },
  });
  expect(screen.getByRole("complementary")).toBeTruthy();
  await waitFor(() => expect(camera().e).not.toBeCloseTo(before.e));
});

it("consolidates dual-stack Docker listeners and makes secondary peers and scope filters explicit", async () => {
  await page.viewport(1100, 760);
  vi.mocked(api.inspectConnections).mockResolvedValueOnce({
    groups: [
      {
        key: "web",
        protocol: "tcp",
        localPort: 443,
        processName: "nginx",
        processId: 742,
        systemdUnit: "nginx.service",
        established: 12,
        remoteAddressCount: 1,
        remotes: [{ address: "203.0.113.9", count: 12 }],
      },
      {
        key: "outbound",
        protocol: "tcp",
        localPort: 49100,
        processName: "agent",
        processId: 900,
        systemdUnit: "agent.service",
        established: 1,
        remoteAddressCount: 1,
        remotes: [{ address: "203.0.113.10", count: 1 }],
      },
    ],
    totalEstablished: 13,
    truncated: false,
    collectedAt: "",
  });
  const source = sockets.items[0];
  renderPane(
    null,
    {
      ...sockets,
      items: [
        source,
        { ...source, id: "web-v6", localAddress: "::", addressFamily: "ipv6" },
        {
          ...source,
          id: "ssh",
          port: 22,
          systemdUnit: "ssh.service",
          processId: 100,
          processName: "sshd",
        },
        {
          ...source,
          id: "redis",
          port: 6379,
          localAddress: "127.0.0.1",
          systemdUnit: "redis.service",
          processId: 200,
          processName: "redis",
        },
      ],
    },
    {
      ...containers,
      items: [{ ...containers.items[0], ports: "0.0.0.0:443->8443/tcp, [::]:443->8443/tcp" }],
    },
  );
  await screen.findByRole("button", { name: /12 established/ });
  const chips = () => document.querySelectorAll(".arch-chip");
  expect(chips()).toHaveLength(3);
  expect(screen.queryByRole("button", { name: /49100/ })).toBeNull();
  expect(document.querySelector(".arch-content")!.textContent).not.toContain("UFW");
  await page.getByRole("button", { name: "Show established connections" }).click();
  expect(chips()).toHaveLength(4);
  expect(screen.getByRole("button", { name: /49100/ }).getAttribute("data-secondary")).toBe("true");
  await page.getByRole("button", { name: "Filter ports" }).click();
  await page.getByRole("combobox", { name: "Graph contents" }).selectOptions("docker");
  expect(chips()).toHaveLength(1);
  await page.getByRole("combobox", { name: "Graph contents" }).selectOptions("listeners");
  expect(
    screen
      .getByRole("button", { name: "Show established connections" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  await page.getByRole("combobox", { name: "Binding scope" }).selectOptions("local-only");
  expect(chips()).toHaveLength(1);
  expect(screen.getByRole("button", { name: /6379.*Listening/ })).toBeTruthy();
  await page.getByRole("combobox", { name: "Binding scope" }).selectOptions("non-loopback");
  expect(chips()).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /6379/ })).toBeNull();
  expect((await axe.run(screen.getByRole("region", { name: "Port filters" }))).violations).toEqual(
    [],
  );
  await page.getByRole("button", { name: "Reset filters" }).click();
  await page.getByRole("button", { name: "Close port tools" }).click();
  await page.getByRole("button", { name: /443.*Listening/ }).click();
  const inspector = screen.getByRole("complementary");
  expect(within(inspector).getByText("2 sockets")).toBeTruthy();
  expect(within(inspector).getByText("IPV4", { exact: true })).toBeTruthy();
  expect(within(inspector).getByText("IPV6", { exact: true })).toBeTruthy();
  expect(within(inspector).getByText("Not tested")).toBeTruthy();
  const diagnostic = within(inspector).getByText("Socket diagnostics");
  expect(diagnostic.closest("details")?.open).toBe(false);
  await page.getByText("Host firewall policy", { exact: true }).click();
  expect(within(inspector).getByText(/Host policy is not a reachability test/)).toBeTruthy();
  expect((await axe.run(document.querySelector(".ports-page")!)).violations).toEqual([]);
  await page.screenshot({ path: "../../test-results/ports-consolidated.png" });
});

it("keeps sshd worker connections immediately below the related SSH listener", async () => {
  await page.viewport(1100, 760);
  vi.mocked(api.inspectConnections).mockResolvedValueOnce({
    groups: [
      {
        key: "ssh-worker",
        protocol: "tcp",
        localPort: 22,
        processName: "sshd",
        processId: 200,
        systemdUnit: null,
        established: 3,
        remoteAddressCount: 1,
        remotes: [{ address: "203.0.113.20", count: 3 }],
      },
    ],
    totalEstablished: 3,
    truncated: false,
    collectedAt: "",
  });
  const source = sockets.items[0];
  renderPane(
    null,
    {
      ...sockets,
      items: [
        {
          ...source,
          id: "ssh",
          port: 22,
          processName: "sshd",
          processId: 100,
          systemdUnit: "ssh.service",
        },
        {
          ...source,
          id: "dns",
          port: 53,
          processName: "resolved",
          processId: 300,
          systemdUnit: "resolved.service",
        },
        {
          ...source,
          id: "web",
          port: 80,
          processName: "nginx",
          processId: 400,
          systemdUnit: "nginx.service",
        },
      ],
    },
    { ...containers, items: [] },
  );
  expect(screen.queryByRole("button", { name: /3 established/ })).toBeNull();
  await page.getByRole("button", { name: "Show established connections" }).click();
  const peer = await screen.findByRole("button", { name: /3 established/ });
  const listener = screen.getByRole("button", { name: /22.*Listening/ });
  expect(peer.closest(".arch-group")).toBe(listener.closest(".arch-group"));
  expect(peer.textContent).toContain("Related process · sshd");
  expect(peer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    listener.getBoundingClientRect().bottom,
  );
  await page.getByRole("button", { name: /3 established/ }).click();
  const inspector = screen.getByRole("complementary");
  expect(within(inspector).getByText("Related to ssh.service")).toBeTruthy();
  expect(within(inspector).getByText("200")).toBeTruthy();
  expect(within(inspector).queryByRole("button", { name: "Open unit" })).toBeNull();
  expect((await axe.run(document.querySelector(".ports-page")!)).violations).toEqual([]);
});
