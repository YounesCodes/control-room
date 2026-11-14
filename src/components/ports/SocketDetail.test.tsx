// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FirewallStatus, ListeningSocket } from "../../types";
import { SocketDetail } from "./SocketDetail";

afterEach(cleanup);

const socket: ListeningSocket = {
  id: "tcp:0.0.0.0:443:0",
  protocol: "tcp",
  addressFamily: "ipv4",
  localAddress: "0.0.0.0",
  port: 443,
  processName: null,
  processId: null,
  systemdUnit: null,
  ownership: "unavailable",
};

it("uses a neutral firewall label when the backend is unavailable", () => {
  render(
    <SocketDetail
      socket={socket}
      containerOwner={null}
      firewall={null}
      onOpenSystemd={vi.fn()}
      onOpenContainer={vi.fn()}
      onViewLogs={vi.fn()}
    />,
  );

  expect(screen.getByText("Firewall", { selector: "dt" })).toBeTruthy();
  expect(screen.getByText("Firewall status unavailable")).toBeTruthy();
});

it("shows Mac application policy and a separate Packet Filter permission failure", () => {
  const firewall: FirewallStatus = {
    backend: "macos",
    available: true,
    active: false,
    defaultIncoming: "Application rules",
    collectedAt: "now",
    rules: [
      {
        to: "/Applications/Test App.app",
        action: "ALLOW",
        from: "Any",
        port: null,
        protocol: null,
        ipv6: false,
      },
    ],
    packetFilter: {
      active: null,
      rules: [],
      error: "Permission denied reading /dev/pf",
      permissionRequired: true,
    },
  };
  render(
    <SocketDetail
      socket={socket}
      firewall={firewall}
      containerOwner={null}
      onOpenSystemd={vi.fn()}
      onOpenContainer={vi.fn()}
      onViewLogs={vi.fn()}
    />,
  );
  expect(screen.getByText("Application Firewall inactive")).toBeTruthy();
  expect(screen.getByText("/Applications/Test App.app")).toBeTruthy();
  expect(screen.getByText("Permission denied reading /dev/pf")).toBeTruthy();
  expect(screen.queryByText(/port allowed/i)).toBeNull();
});
