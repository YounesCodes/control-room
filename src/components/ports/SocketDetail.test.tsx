// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ListeningSocket } from "../../types";
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
