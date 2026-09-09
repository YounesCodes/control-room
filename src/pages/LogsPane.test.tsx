// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, CachedList, SavedConnection, SystemdUnit } from "../types";

let outputHandler: ((message: ArrayBuffer) => void) | undefined;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    set onmessage(handler: (message: ArrayBuffer) => void) {
      outputHandler = handler;
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

const api = vi.hoisted(() => ({
  startJournalStream: vi.fn(),
  startDockerLogStream: vi.fn(),
  stopLogStream: vi.fn(),
  listServices: vi.fn(),
  listContainers: vi.fn(),
}));
vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { LogsPane } from "./LogsPane";

const connection: SavedConnection = {
  id: "connection-a",
  displayName: "Host A",
  destination: "host-a",
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
const settings: AppSettings = {
  terminalFontFamily: "Cascadia Mono",
  terminalFontSize: 14,
  terminalScrollback: 10_000,
  terminalForeground: "#f2f2ee",
  terminalRed: "#ff6f7d",
  terminalGreen: "#52cf91",
  terminalYellow: "#e8c56c",
  terminalBlue: "#55aef2",
  terminalMagenta: "#c793ff",
  terminalCyan: "#65d4d1",
  defaultLogTail: 200,
  globalHistoryEnabled: true,
  globalSudoEnabled: false,
  automaticUpdateChecks: true,
};
const service: SystemdUnit = {
  id: "ssh.service",
  unitType: "service",
  description: "SSH",
  loadState: "loaded",
  activeState: "active",
  subState: "running",
  unitFileState: "enabled",
};
const servicesCache: CachedList<SystemdUnit> = {
  items: [service],
  fetchedAt: Date.now(),
  loading: false,
  error: null,
};

describe("LogsPane reading position", () => {
  beforeEach(() => {
    outputHandler = undefined;
    api.startJournalStream.mockResolvedValue({ streamId: "stream-a" });
    api.stopLogStream.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("separates receiving lines, wrapping, and keeping the viewport at the latest line", async () => {
    const user = userEvent.setup();
    render(
      <LogsPane
        connection={connection}
        settings={settings}
        logTailOptions={[200]}
        servicesCache={servicesCache}
        containersCache={{ items: [], fetchedAt: Date.now(), loading: false, error: null }}
        selectedSource={{ type: "systemd", id: service.id }}
        onServicesCacheChange={vi.fn()}
        onContainersCacheChange={vi.fn()}
        onSourceChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Receive new lines" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Start" }));
    const output = await screen.findByText(/stream started/);
    const pre = output.closest("pre") as HTMLPreElement;
    Object.defineProperties(pre, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    pre.scrollTop = 100;
    fireEvent.scroll(pre);
    expect(screen.getByRole("button", { name: /Jump to latest/ })).toBeTruthy();

    outputHandler?.(new TextEncoder().encode("new line\n").buffer);
    await waitFor(() => expect(screen.getByRole("button", { name: /1 new/ })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /Jump to latest/ }));
    expect(pre.scrollTop).toBe(1000);

    await user.click(screen.getByRole("button", { name: "Wrap lines" }));
    expect(pre.classList.contains("log-output-wrapped")).toBe(false);
  });
});
