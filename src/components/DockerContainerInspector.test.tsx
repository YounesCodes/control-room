// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerContainer, DockerContainerDetails } from "../types";
import { DockerContainerInspector } from "./DockerContainerInspector";

const id = "a".repeat(64);
const summary: DockerContainer = {
  id,
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
  startedAt: "2026-08-31T01:00:00Z",
  finishedAt: null,
  healthStatus: "unhealthy",
  failingStreak: 2,
  restartPolicy: "unless-stopped",
  restartMaximumRetryCount: 0,
  publishedPorts: [{ containerPort: "8443/tcp", hostAddress: "0.0.0.0", hostPort: 443 }],
  networks: [
    {
      name: "proxy_default",
      ipv4Address: "172.20.0.2",
      ipv4Gateway: "172.20.0.1",
      ipv6Address: null,
      ipv6Gateway: null,
    },
  ],
  mounts: [
    {
      mountType: "bind",
      name: null,
      destination: "/etc/gateway",
      writable: false,
      propagation: "rprivate",
    },
  ],
  composeProject: "proxy",
  composeService: "gateway",
  composeContainerNumber: 1,
  composeOneoff: false,
};

describe("DockerContainerInspector", () => {
  afterEach(cleanup);

  it("opens the exact published binding in Ports", async () => {
    const onOpenPort = vi.fn();
    render(
      <DockerContainerInspector
        summary={summary}
        cache={{
          value: {
            ...details,
            publishedPorts: [{ hostAddress: "::", hostPort: 443, containerPort: "8443/udp" }],
          },
          fetchedAt: Date.now(),
          loading: false,
          error: null,
        }}
        onRefresh={vi.fn()}
        onRetryWithSudo={vi.fn()}
        onViewLogs={vi.fn()}
        onOpenPort={onOpenPort}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("Published ports", { selector: "summary" }));
    await user.click(screen.getByRole("button", { name: "Open [::]:443 → 8443/udp in Ports" }));
    expect(onOpenPort).toHaveBeenCalledExactlyOnceWith({
      containerId: id,
      hostAddress: "::",
      hostPort: 443,
      containerPort: "8443/udp",
    });
  });

  it("shows typed sections and never renders sensitive Docker fields", async () => {
    const user = userEvent.setup();
    render(
      <DockerContainerInspector
        summary={summary}
        cache={{ value: details, fetchedAt: Date.now(), loading: false, error: null }}
        onRefresh={vi.fn()}
        onRetryWithSudo={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );

    const technical = screen.getByText("Technical identifiers").closest("details");
    expect(technical?.open).toBe(false);
    expect(screen.getByText("Previous stop")).toBeTruthy();
    expect(screen.getByText("sha256:abc")).toBeTruthy();
    await user.click(screen.getByText("Published ports", { selector: "summary" }));
    expect(
      screen.getByRole("button", { name: "Open 0.0.0.0:443 → 8443/tcp in Ports" }),
    ).toBeTruthy();
    await user.click(screen.getByText("Networks", { selector: "summary" }));
    expect(screen.getByText("proxy_default")).toBeTruthy();
    await user.click(screen.getByText("Mounts", { selector: "summary" }));
    expect(screen.getByText("/etc/gateway")).toBeTruthy();
    await user.click(screen.getByText("Container & Compose", { selector: "summary" }));
    expect(
      screen.getByText(
        "Environment values, command arguments, arbitrary labels, health logs, and host mount sources are not collected.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret=value");
  });

  it.each([false, true])(
    "offers sudo only for Linux permission errors (Windows: %s)",
    (windowsHost) => {
      render(
        <DockerContainerInspector
          summary={summary}
          windowsHost={windowsHost}
          cache={{
            value: null,
            fetchedAt: null,
            loading: false,
            error: "Permission denied while opening Docker",
          }}
          onRefresh={vi.fn()}
          onRetryWithSudo={vi.fn()}
          onViewLogs={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("button", { name: windowsHost ? "Retry" : "Retry with sudo" }),
      ).toBeTruthy();
    },
  );
});
