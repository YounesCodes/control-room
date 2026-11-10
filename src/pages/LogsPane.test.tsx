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

  it("keeps an explicitly opened dependency as the journal source when it is outside the inventory", async () => {
    const onSourceChange = vi.fn();
    render(
      <LogsPane
        connection={connection}
        settings={settings}
        logTailOptions={[200]}
        servicesCache={servicesCache}
        containersCache={{ items: [], fetchedAt: Date.now(), loading: false, error: null }}
        selectedSource={{ type: "systemd", id: "network-online.target" }}
        onServicesCacheChange={vi.fn()}
        onContainersCacheChange={vi.fn()}
        onSourceChange={onSourceChange}
      />,
    );
    expect((screen.getByRole("combobox", { name: "Unit" }) as HTMLSelectElement).value).toBe(
      "network-online.target",
    );
    expect(onSourceChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(api.startJournalStream.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "connection-a",
      "network-online.target",
    ]);
  });

  it("offers only Docker logs on Windows and keeps access failures free of sudo prompts", async () => {
    api.startDockerLogStream.mockRejectedValueOnce(new Error("Permission denied by Docker"));
    render(
      <LogsPane
        connection={connection}
        windowsHost
        settings={settings}
        logTailOptions={[200]}
        servicesCache={servicesCache}
        containersCache={{
          items: [
            { id: "container-fixture", name: "Windows container" },
          ] as import("../types").DockerContainer[],
          fetchedAt: Date.now(),
          loading: false,
          error: null,
        }}
        selectedSource={{ type: "docker", id: "container-fixture" }}
        onServicesCacheChange={vi.fn()}
        onContainersCacheChange={vi.fn()}
        onSourceChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("option", { name: "Systemd" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Permission denied by Docker");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.startJournalStream).not.toHaveBeenCalled();
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
    const pre = output.closest("[role='log']") as HTMLDivElement;
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
    await screen.findByText("Streaming");
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
    await screen.findByText("Starting…");
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
    expect(screen.getByText("Stopped")).toBeTruthy();
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
    expect(screen.getByText("Stopped")).toBeTruthy();
  });

  it("ignores output and state events from a stopped stream after a new stream starts", async () => {
    mountLogs();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    const oldOutput = outputHandler;
    await screen.findByText("Streaming");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    api.startJournalStream.mockResolvedValueOnce({ streamId: "stream-b" });
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Streaming");
    await act(async () => {
      oldOutput?.(new TextEncoder().encode("OLD_OUTPUT\n").buffer);
      events.handler?.({
        payload: { streamId: "stream-a", state: "error", reason: "old failure" },
      });
    });
    await chunk("NEW_OUTPUT\n");
    expect(await screen.findByText(/NEW_OUTPUT/)).toBeTruthy();
    expect(screen.queryByText(/OLD_OUTPUT|old failure/)).toBeNull();
    expect(screen.getByText("Streaming")).toBeTruthy();
  });

  it("buffers received output during pause and drains it on resume", async () => {
    mountLogs();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Streaming");
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    await chunk("BUFFERED_LINE\n");
    expect(screen.queryByText(/BUFFERED_LINE/)).toBeNull();
    expect(screen.getByText("Paused")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByText(/BUFFERED_LINE/)).toBeTruthy();
    expect(api.stopLogStream).not.toHaveBeenCalled();
  });

  it("keeps an actionable error after a failed stop and retries", async () => {
    api.stopLogStream.mockRejectedValueOnce(new Error("Could not stop reader"));
    mountLogs();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Streaming");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText(/Could not stop reader/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Stopped");
  });

  it("shows startup failures and permits another start", async () => {
    api.startJournalStream.mockRejectedValueOnce(new Error("Remote host is offline"));
    mountLogs();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Remote host is offline")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Streaming");
    expect(screen.queryByText("Remote host is offline")).toBeNull();
  });
});

describe("LogsPane reading aids", () => {
  const journal = [
    "2026-11-01T09:58:01.000001+00:00 host-a worker[1]: batch 1 finished",
    "2026-11-01T09:58:02.000001+00:00 host-a worker[1]: warning: queue depth high",
    "2026-11-01T09:58:03.000001+00:00 host-a worker[1]: error: job 7 failed",
    "2026-11-01T09:58:04.000001+00:00 host-a worker[1]: batch 2 finished",
  ].join("\n");

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

  async function streamJournal() {
    mountLogs();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Streaming");
    await chunk(`${journal}\n`);
    await screen.findByText(/batch 2 finished/);
    return screen.getByRole("log", { name: "Log output for ssh.service" });
  }

  it("counts warning and error lines and filters to one level", async () => {
    const log = await streamJournal();
    const errors = screen.getByRole("button", { name: /^Errors/ });
    expect(errors.textContent).toBe("Errors1");
    expect(screen.getByRole("button", { name: /^Warnings/ }).textContent).toBe("Warnings1");
    expect(screen.getByRole("button", { name: /^All/ }).textContent).toBe("All4");

    await userEvent.click(errors);
    expect(errors.getAttribute("aria-pressed")).toBe("true");
    expect(log.textContent).toContain("job 7 failed");
    expect(log.textContent).not.toContain("batch 1 finished");
    expect(log.textContent).not.toContain("stream started");
    expect(log.querySelector("[data-level='error']")?.getAttribute("data-line")).toBe("4");
  });

  it("explains an empty filter result and returns to all lines", async () => {
    await streamJournal();
    await userEvent.type(screen.getByRole("textbox", { name: "Search loaded lines" }), "nothing");
    expect(await screen.findByText("No loaded lines match “nothing”.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show all lines" }));
    expect(await screen.findByText(/batch 1 finished/)).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "Search loaded lines" }) as HTMLInputElement).value,
    ).toBe("");
  });

  it("marks search matches, counts them, and clears with Escape", async () => {
    const log = await streamJournal();
    const search = screen.getByRole("textbox", { name: "Search loaded lines" });
    await userEvent.type(search, "FINISHED");
    expect(await screen.findByText("2 matches")).toBeTruthy();
    expect([...log.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
      "finished",
      "finished",
    ]);
    await userEvent.keyboard("{Escape}");
    expect((search as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(log.querySelectorAll("mark")).toHaveLength(0));
  });

  it("focuses search with Ctrl+F", async () => {
    mountLogs();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Search loaded lines" }),
    );
  });

  it("keeps the log scrollable by keyboard without announcing every line", async () => {
    const log = await streamJournal();
    expect(log.tabIndex).toBe(0);
    expect(log.getAttribute("aria-live")).toBe("off");
    // Line numbers are CSS-generated, so copied text and reading order hold only host output.
    expect(log.querySelector(".log-line")?.textContent).toBe(
      "[systemd ssh.service] stream started",
    );
  });

  it("restarts the stream when a different unit is chosen while streaming", async () => {
    const other: SystemdUnit = { ...service, id: "cron.service", description: "Cron" };
    render(
      <LogsPane
        connection={connection}
        settings={settings}
        logTailOptions={[200]}
        servicesCache={{ ...servicesCache, items: [service, other] }}
        containersCache={{ items: [], fetchedAt: Date.now(), loading: false, error: null }}
        selectedSource={{ type: "systemd", id: service.id }}
        onServicesCacheChange={vi.fn()}
        onContainersCacheChange={vi.fn()}
        onSourceChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Streaming");
    api.startJournalStream.mockResolvedValueOnce({ streamId: "stream-b" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Unit" }), "cron.service");
    await waitFor(() => expect(api.stopLogStream).toHaveBeenCalledWith("stream-a"));
    await waitFor(() =>
      expect(api.startJournalStream.mock.calls.at(-1)?.slice(0, 2)).toEqual([
        "connection-a",
        "cron.service",
      ]),
    );
    expect(await screen.findByText("[systemd cron.service] stream started")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("does not start a stream when the unit changes while stopped", async () => {
    const other: SystemdUnit = { ...service, id: "cron.service", description: "Cron" };
    render(
      <LogsPane
        connection={connection}
        settings={settings}
        logTailOptions={[200]}
        servicesCache={{ ...servicesCache, items: [service, other] }}
        containersCache={{ items: [], fetchedAt: Date.now(), loading: false, error: null }}
        selectedSource={{ type: "systemd", id: service.id }}
        onServicesCacheChange={vi.fn()}
        onContainersCacheChange={vi.fn()}
        onSourceChange={vi.fn()}
      />,
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Unit" }), "cron.service");
    expect(api.startJournalStream).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Start reads the last 200 lines of cron.service, then new lines as they arrive.",
      ),
    ).toBeTruthy();
  });

  it("reports how many lines are waiting while paused", async () => {
    await streamJournal();
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    await chunk("held one\nheld two\n");
    expect(await screen.findByText("2 new lines waiting")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(screen.queryByText(/new lines waiting/)).toBeNull();
    expect(await screen.findByText(/held two/)).toBeTruthy();
  });
});
