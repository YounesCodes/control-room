// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  CachedList,
  SavedConnection,
  SystemdUnit,
  StreamStateEvent,
} from "../types";

let outputHandler: ((message: ArrayBuffer) => void) | undefined;
const events = vi.hoisted(() => ({
  handler: null as ((event: { payload: StreamStateEvent }) => void) | null,
  dispose: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    set onmessage(handler: (message: ArrayBuffer) => void) {
      outputHandler = handler;
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: typeof events.handler) => {
    events.handler = handler;
    return events.dispose;
  }),
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
  hiddenLocalShells: [],
  localTerminalMode: false,
  defaultLocalShellId: null,
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

function mountLogs() {
  return render(
    <LogsPane
      connection={connection}
      settings={settings}
      logTailOptions={[200]}
      servicesCache={{ ...servicesCache, fetchedAt: Date.now() }}
      containersCache={{ items: [], fetchedAt: Date.now(), loading: false, error: null }}
      selectedSource={{ type: "systemd", id: service.id }}
      onServicesCacheChange={vi.fn()}
      onContainersCacheChange={vi.fn()}
      onSourceChange={vi.fn()}
    />,
  );
}
async function chunk(text: string) {
  await act(async () => outputHandler?.(new TextEncoder().encode(text).buffer));
}

describe("LogsPane reading position", () => {
  beforeEach(() => {
    outputHandler = undefined;
    events.handler = null;
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

  it("stops the native stream and unregisters the listener on unmount", async () => {
    const view = mountLogs();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Stream active");
    view.unmount();
    expect(api.stopLogStream).toHaveBeenCalledExactlyOnceWith("stream-a");
    expect(events.dispose).toHaveBeenCalledOnce();
  });

  it("stops a stream whose start completes after the pane unmounts", async () => {
    let finish!: (value: { streamId: string }) => void;
    api.startJournalStream.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = mountLogs();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Starting stream");
    view.unmount();
    await act(async () => finish({ streamId: "late-stream" }));
    expect(api.stopLogStream).toHaveBeenCalledWith("late-stream");
  });

  it("stops a stream cancelled while its start is pending", async () => {
    let finish!: (value: { streamId: string }) => void;
    api.startJournalStream.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mountLogs();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await act(async () => finish({ streamId: "cancelled-stream" }));
    expect(api.stopLogStream).toHaveBeenCalledWith("cancelled-stream");
    expect(screen.getByText("Stream stopped")).toBeTruthy();
  });

  it("applies an error event received before the start IPC returns", async () => {
    let finish!: (value: { streamId: string }) => void;
    api.startJournalStream.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mountLogs();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await act(async () =>
      events.handler?.({
        payload: { streamId: "early-stream", state: "error", reason: "journal access failed" },
      }),
    );
    await act(async () => finish({ streamId: "early-stream" }));
    expect(await screen.findByText("journal access failed")).toBeTruthy();
    expect(screen.getByText("Stream stopped")).toBeTruthy();
  });

  it("ignores output and state events from a stopped stream after a new stream starts", async () => {
    mountLogs();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    const oldOutput = outputHandler;
    await screen.findByText("Stream active");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    api.startJournalStream.mockResolvedValueOnce({ streamId: "stream-b" });
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Stream active");
    await act(async () => {
      oldOutput?.(new TextEncoder().encode("OLD_OUTPUT\n").buffer);
      events.handler?.({
        payload: { streamId: "stream-a", state: "error", reason: "old failure" },
      });
    });
    await chunk("NEW_OUTPUT\n");
    expect(await screen.findByText(/NEW_OUTPUT/)).toBeTruthy();
    expect(screen.queryByText(/OLD_OUTPUT|old failure/)).toBeNull();
    expect(screen.getByText("Stream active")).toBeTruthy();
  });

  it("buffers received output during pause and drains it on resume", async () => {
    mountLogs();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Stream active");
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    await chunk("BUFFERED_LINE\n");
    expect(screen.queryByText(/BUFFERED_LINE/)).toBeNull();
    expect(screen.getByText("Rendering paused")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByText(/BUFFERED_LINE/)).toBeTruthy();
    expect(api.stopLogStream).not.toHaveBeenCalled();
  });

  it("keeps an actionable error after a failed stop and retries", async () => {
    api.stopLogStream.mockRejectedValueOnce(new Error("Could not stop reader"));
    mountLogs();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Stream active");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText(/Could not stop reader/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Stream stopped");
  });

  it("shows startup failures and permits another start", async () => {
    api.startJournalStream.mockRejectedValueOnce(new Error("Remote host is offline"));
    mountLogs();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Remote host is offline")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Stream active");
    expect(screen.queryByText("Remote host is offline")).toBeNull();
  });
});
