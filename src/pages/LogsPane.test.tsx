// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  CachedList,
  LogSourceSelection,
  SavedConnection,
  SystemdUnit,
  StreamNoticeEvent,
  StreamStateEvent,
} from "../types";

let outputHandler: ((message: ArrayBuffer) => void) | undefined;
const events = vi.hoisted(() => ({
  handler: null as ((event: { payload: StreamStateEvent }) => void) | null,
  notice: null as ((event: { payload: StreamNoticeEvent }) => void) | null,
  dispose: vi.fn(),
  disposeNotice: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    set onmessage(handler: (message: ArrayBuffer) => void) {
      outputHandler = handler;
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: never) => {
    if (name === "stream-notice") {
      events.notice = handler;
      return events.disposeNotice;
    }
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

  it("can read all unified logs even when launchd inventory is unavailable", async () => {
    render(
      <LogsPane
        macosHost
        connection={connection}
        settings={settings}
        logTailOptions={[200]}
        servicesCache={{
          items: [],
          fetchedAt: Date.now(),
          loading: false,
          error: "No service domains",
        }}
        containersCache={{ items: [], fetchedAt: Date.now(), loading: false, error: null }}
        selectedSource={{ type: "systemd", id: "all" }}
        onServicesCacheChange={vi.fn()}
        onContainersCacheChange={vi.fn()}
        onSourceChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: "Unified log" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "All unified logs" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(api.startJournalStream).toHaveBeenCalled());
    expect(api.startJournalStream.mock.calls[0].slice(0, 2)).toEqual([connection.id, "all"]);
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
    expect(events.disposeNotice).toHaveBeenCalledOnce();
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

describe("LogsPane source switching", () => {
  const cron: SystemdUnit = { ...service, id: "cron.service", description: "Cron" };
  const backup: SystemdUnit = { ...service, id: "backup.service", description: "Backup" };
  const containers = [
    { id: "container-a", name: "api" },
    { id: "container-b", name: "worker" },
  ] as import("../types").DockerContainer[];
  const errorLines =
    "2026-11-01T09:58:01.000001+00:00 host-a sshd[1]: error: OLD_SOURCE_FAILURE\n" +
    "2026-11-01T09:58:02.000001+00:00 host-a sshd[1]: warning: OLD_SOURCE_WARNING\n";
  let streams = 0;

  function mountSources(selected: LogSourceSelection = { type: "systemd", id: service.id }) {
    return render(
      <LogsPane
        connection={connection}
        settings={settings}
        logTailOptions={[100, 200]}
        servicesCache={{ ...servicesCache, items: [service, cron, backup] }}
        containersCache={{ items: containers, fetchedAt: Date.now(), loading: false, error: null }}
        selectedSource={selected}
        onServicesCacheChange={vi.fn()}
        onContainersCacheChange={vi.fn()}
        onSourceChange={vi.fn()}
      />,
    );
  }
  const unitSelect = () => screen.getByRole("combobox", { name: "Unit" });
  const log = () => screen.queryByRole("log");
  const count = (name: string) =>
    screen.getByRole("button", { name: new RegExp(`^${name}`) }).textContent;

  async function streamOldSource() {
    mountSources();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Streaming");
    await chunk(errorLines);
    await screen.findByText(/OLD_SOURCE_FAILURE/);
    expect(count("Errors")).toBe("Errors1");
  }

  beforeEach(() => {
    streams = 0;
    outputHandler = undefined;
    events.handler = null;
    api.startJournalStream.mockImplementation(async () => ({ streamId: `stream-${++streams}` }));
    api.startDockerLogStream.mockImplementation(async () => ({
      streamId: `docker-${++streams}`,
    }));
    api.stopLogStream.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("starts the new unit in a fresh view while streaming", async () => {
    await streamOldSource();
    await userEvent.selectOptions(unitSelect(), "cron.service");
    expect(await screen.findByText("[systemd cron.service] stream started")).toBeTruthy();
    expect(log()?.textContent).not.toMatch(/OLD_SOURCE|ssh\.service/);
    expect(count("Errors")).toBe("Errors0");
    expect(count("Warnings")).toBe("Warnings0");
    await chunk("2026-11-01T09:59:00.000001+00:00 host-a cron[2]: error: NEW_SOURCE_FAILURE\n");
    await screen.findByText(/NEW_SOURCE_FAILURE/);
    expect(count("Errors")).toBe("Errors1");
  });

  it("clears the previous unit lines when the unit changes while stopped", async () => {
    await streamOldSource();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Stopped");
    await userEvent.selectOptions(unitSelect(), "cron.service");
    expect(log()).toBeNull();
    expect(count("Errors")).toBe("Errors0");
    expect(
      screen.getByText(
        "Start reads the last 200 lines of cron.service, then new lines as they arrive.",
      ),
    ).toBeTruthy();
    expect(api.startJournalStream).toHaveBeenCalledTimes(1);
  });

  it("drops held and partial lines from the previous unit", async () => {
    await streamOldSource();
    await chunk("PARTIAL_OLD_LINE");
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    await chunk("\n2026-11-01T09:58:03.000001+00:00 host-a sshd[1]: error: HELD_OLD_LINE\n");
    await userEvent.selectOptions(unitSelect(), "cron.service");
    await screen.findByText("[systemd cron.service] stream started");
    await screen.findByText("Streaming");
    expect(log()?.textContent).not.toMatch(/HELD_OLD_LINE|PARTIAL_OLD_LINE|OLD_SOURCE/);
    expect(count("Errors")).toBe("Errors0");
    expect(screen.queryByText(/new lines? waiting/)).toBeNull();
  });

  it("ignores late output and state from the previous unit stream", async () => {
    await streamOldSource();
    const oldOutput = outputHandler;
    await userEvent.selectOptions(unitSelect(), "cron.service");
    await screen.findByText("[systemd cron.service] stream started");
    await act(async () => oldOutput?.(new TextEncoder().encode("error: LATE_OLD_OUTPUT\n").buffer));
    await act(async () =>
      events.handler?.({ payload: { streamId: "stream-1", state: "error", reason: "old gone" } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(log()?.textContent).not.toContain("LATE_OLD_OUTPUT");
    expect(screen.queryByText("old gone")).toBeNull();
    expect(count("Errors")).toBe("Errors0");
    expect(screen.getByText("Streaming")).toBeTruthy();
  });

  it("clears systemd lines when switching to Docker and streams the first container", async () => {
    await streamOldSource();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Source" }), "docker");
    expect(await screen.findByText("[docker api] stream started")).toBeTruthy();
    expect(api.startDockerLogStream.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "connection-a",
      "container-a",
    ]);
    expect(log()?.textContent).not.toContain("OLD_SOURCE");
    expect(count("Errors")).toBe("Errors0");
  });

  it("clears systemd lines when switching to Docker while stopped", async () => {
    await streamOldSource();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Stopped");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Source" }), "docker");
    await screen.findByRole("combobox", { name: "Container" });
    expect(log()).toBeNull();
    expect(count("Errors")).toBe("Errors0");
    expect(api.startDockerLogStream).not.toHaveBeenCalled();
  });

  it("clears one container lines when switching to another", async () => {
    mountSources({ type: "docker", id: "container-a" });
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Streaming");
    await chunk("ERROR API_CONTAINER_FAILURE\n");
    await screen.findByText(/API_CONTAINER_FAILURE/);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Container" }),
      "container-b",
    );
    expect(await screen.findByText("[docker worker] stream started")).toBeTruthy();
    expect(log()?.textContent).not.toContain("API_CONTAINER_FAILURE");
    expect(count("Errors")).toBe("Errors0");
  });

  it("streams the last unit chosen when stops resolve out of order", async () => {
    await streamOldSource();
    const pending: (() => void)[] = [];
    api.stopLogStream.mockImplementation(
      () => new Promise<void>((resolve) => pending.push(() => resolve())),
    );
    fireEvent.change(unitSelect(), { target: { value: "cron.service" } });
    fireEvent.change(unitSelect(), { target: { value: "backup.service" } });
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    // Resolve the newest request first, then the older one.
    await act(async () => {
      for (const resolve of [...pending].reverse()) resolve();
    });
    api.stopLogStream.mockResolvedValue(undefined);
    await screen.findByText("[systemd backup.service] stream started");
    await screen.findByText("Streaming");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = api.startJournalStream.mock.calls.map((call) => call[1]);
    expect(started.at(-1)).toBe("backup.service");
    expect(started).not.toContain("cron.service");
    expect((unitSelect() as HTMLSelectElement).value).toBe("backup.service");
    expect(log()?.textContent).not.toMatch(/cron\.service|OLD_SOURCE/);
  });

  it("clears the previous unit error when another unit is chosen", async () => {
    api.startJournalStream.mockRejectedValueOnce(new Error("journal access failed for ssh"));
    mountSources();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("journal access failed for ssh");
    await userEvent.selectOptions(unitSelect(), "cron.service");
    expect(screen.queryByText("journal access failed for ssh")).toBeNull();
  });

  it("rereads into a fresh view when the line count changes while streaming", async () => {
    await streamOldSource();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Lines" }), "100");
    await waitFor(() => expect(api.startJournalStream).toHaveBeenCalledTimes(2));
    expect(api.startJournalStream.mock.calls.at(-1)?.slice(1, 3)).toEqual(["ssh.service", 100]);
    await screen.findByText("Streaming");
    expect(log()?.textContent).not.toContain("OLD_SOURCE");
    expect(screen.getAllByText("[systemd ssh.service] stream started")).toHaveLength(1);
  });

  it("keeps earlier lines above a divider when the same unit starts again", async () => {
    await streamOldSource();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Stopped");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Streaming");
    expect(screen.getAllByText("[systemd ssh.service] stream started")).toHaveLength(2);
    expect(log()?.textContent).toContain("OLD_SOURCE_FAILURE");
  });
});

describe("LogsPane stream lifecycle while switching", () => {
  const cron: SystemdUnit = { ...service, id: "cron.service", description: "Cron" };
  const backup: SystemdUnit = { ...service, id: "backup.service", description: "Backup" };
  let streams = 0;

  function props(overrides: Partial<Parameters<typeof LogsPane>[0]> = {}) {
    return {
      connection,
      settings,
      logTailOptions: [200],
      servicesCache: { ...servicesCache, items: [service, cron, backup] },
      containersCache: { items: [], fetchedAt: Date.now(), loading: false, error: null },
      selectedSource: { type: "systemd", id: service.id } as LogSourceSelection,
      onServicesCacheChange: vi.fn(),
      onContainersCacheChange: vi.fn(),
      onSourceChange: vi.fn(),
      ...overrides,
    };
  }
  const unitSelect = () => screen.getByRole("combobox", { name: "Unit" }) as HTMLSelectElement;
  async function startStreaming() {
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Streaming");
  }

  beforeEach(() => {
    streams = 0;
    outputHandler = undefined;
    events.handler = null;
    api.startJournalStream.mockImplementation(async () => ({ streamId: `stream-${++streams}` }));
    api.startDockerLogStream.mockImplementation(async () => ({
      streamId: `docker-${++streams}`,
    }));
    api.stopLogStream.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("stops the previous stream once when units change in quick succession", async () => {
    render(<LogsPane {...props()} />);
    await startStreaming();
    let release!: () => void;
    api.stopLogStream.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = () => resolve())),
    );
    fireEvent.change(unitSelect(), { target: { value: "cron.service" } });
    fireEvent.change(unitSelect(), { target: { value: "backup.service" } });
    await act(async () => release());
    await screen.findByText("[systemd backup.service] stream started");
    await screen.findByText("Streaming");
    expect(api.stopLogStream.mock.calls.filter(([id]) => id === "stream-1")).toHaveLength(1);
    expect(screen.queryByText(/Could not stop/)).toBeNull();
    expect(api.startJournalStream.mock.calls.map((call) => call[1])).toEqual([
      "ssh.service",
      "backup.service",
    ]);
  });

  it("keeps the unit selector enabled and focused during a restart", async () => {
    render(<LogsPane {...props()} />);
    await startStreaming();
    let release!: () => void;
    api.stopLogStream.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = () => resolve())),
    );
    unitSelect().focus();
    await userEvent.selectOptions(unitSelect(), "cron.service");
    expect(screen.getByText("Stopping…")).toBeTruthy();
    expect(unitSelect().disabled).toBe(false);
    expect(document.activeElement).toBe(unitSelect());
    await act(async () => release());
    await screen.findByText("Streaming");
    expect(document.activeElement).toBe(unitSelect());
  });

  it("cancels a pending restart when Stop is pressed", async () => {
    render(<LogsPane {...props()} />);
    await startStreaming();
    let finish!: (value: { streamId: string }) => void;
    api.startJournalStream.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    await userEvent.selectOptions(unitSelect(), "cron.service");
    await screen.findByText("Starting…");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await act(async () => finish({ streamId: "late-cron" }));
    expect(api.stopLogStream).toHaveBeenCalledWith("late-cron");
    expect(screen.getByText("Stopped")).toBeTruthy();
    await userEvent.selectOptions(unitSelect(), "backup.service");
    expect(api.startJournalStream).toHaveBeenCalledTimes(2);
  });

  it("treats a stream that already ended as stopped", async () => {
    render(<LogsPane {...props()} />);
    await startStreaming();
    api.stopLogStream.mockRejectedValueOnce(new Error("Log Stream is no longer active"));
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Stopped");
    expect(screen.queryByText(/Could not stop/)).toBeNull();
  });

  it("does not restart after the stream ends on its own", async () => {
    render(<LogsPane {...props()} />);
    await startStreaming();
    await act(async () =>
      events.handler?.({ payload: { streamId: "stream-1", state: "stopped", reason: null } }),
    );
    await screen.findByText("Stopped");
    await userEvent.selectOptions(unitSelect(), "cron.service");
    expect(api.startJournalStream).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("restarts with the replacement when a refreshed list drops the streamed container", async () => {
    const containers = [
      { id: "container-a", name: "api" },
      { id: "container-b", name: "worker" },
    ] as import("../types").DockerContainer[];
    const view = render(
      <LogsPane
        {...props({
          containersCache: {
            items: containers,
            fetchedAt: Date.now(),
            loading: false,
            error: null,
          },
          selectedSource: { type: "docker", id: "container-a" },
        })}
      />,
    );
    await startStreaming();
    await chunk("ERROR REMOVED_CONTAINER_LINE\n");
    await screen.findByText(/REMOVED_CONTAINER_LINE/);
    view.rerender(
      <LogsPane
        {...props({
          containersCache: {
            items: [containers[1]],
            fetchedAt: Date.now(),
            loading: false,
            error: null,
          },
          selectedSource: { type: "docker", id: "container-a" },
        })}
      />,
    );
    expect(await screen.findByText("[docker worker] stream started")).toBeTruthy();
    expect(screen.getByRole("log").textContent).not.toContain("REMOVED_CONTAINER_LINE");
    expect(api.startDockerLogStream.mock.calls.at(-1)?.[1]).toBe("container-b");
  });
});

describe("LogsPane restricted journal access", () => {
  const cron: SystemdUnit = { ...service, id: "cron.service", description: "Cron" };
  const warning = /can’t read the system journal/;
  let streams = 0;

  function mount(windowsHost = false) {
    return render(
      <LogsPane
        connection={connection}
        windowsHost={windowsHost}
        settings={settings}
        logTailOptions={[200]}
        servicesCache={{ ...servicesCache, items: [service, cron] }}
        containersCache={{ items: [], fetchedAt: Date.now(), loading: false, error: null }}
        selectedSource={{ type: "systemd", id: service.id }}
        onServicesCacheChange={vi.fn()}
        onContainersCacheChange={vi.fn()}
        onSourceChange={vi.fn()}
      />,
    );
  }
  const notice = (streamId: string) =>
    act(async () => events.notice?.({ payload: { streamId, notice: "journal-restricted" } }));
  async function startRestricted() {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Streaming");
    await chunk("-- No entries --\n");
    await notice("stream-1");
    return screen.findByText(warning);
  }

  beforeEach(() => {
    streams = 0;
    outputHandler = undefined;
    events.handler = null;
    events.notice = null;
    api.startJournalStream.mockImplementation(async () => ({ streamId: `stream-${++streams}` }));
    api.stopLogStream.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("explains an empty journal the account is not allowed to read", async () => {
    const banner = await startRestricted();
    expect(banner.closest("[role='status']")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry with sudo" })).toBeTruthy();
    expect(await screen.findByText("-- No entries --")).toBeTruthy();
  });

  it("keeps the warning after a one-shot read ends", async () => {
    await startRestricted();
    await act(async () =>
      events.handler?.({ payload: { streamId: "stream-1", state: "stopped", reason: null } }),
    );
    await screen.findByText("Stopped");
    expect(screen.getByText(warning)).toBeTruthy();
  });

  it("rereads with sudo into a fresh view and clears the warning", async () => {
    await startRestricted();
    await userEvent.click(screen.getByRole("button", { name: "Retry with sudo" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/password/i), "example-password");
    await userEvent.click(within(dialog).getByRole("button", { name: /retry|continue|run|ok/i }));
    await waitFor(() => expect(api.startJournalStream).toHaveBeenCalledTimes(2));
    expect(api.startJournalStream.mock.calls.at(-1)?.[4]).toBe("example-password");
    await screen.findByText("Streaming");
    expect(screen.queryByText(warning)).toBeNull();
    expect(screen.queryByText("-- No entries --")).toBeNull();
    expect(screen.getAllByText("[systemd ssh.service] stream started")).toHaveLength(1);
  });

  it("applies a notice that arrives before the start request returns", async () => {
    let finish!: (value: { streamId: string }) => void;
    api.startJournalStream.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Starting…");
    await notice("early-stream");
    expect(screen.queryByText(warning)).toBeNull();
    await act(async () => finish({ streamId: "early-stream" }));
    expect(await screen.findByText(warning)).toBeTruthy();
  });

  it("ignores notices from other streams and clears on another unit", async () => {
    await startRestricted();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Unit" }), "cron.service");
    await screen.findByText("[systemd cron.service] stream started");
    expect(screen.queryByText(warning)).toBeNull();
    await notice("stream-1");
    await notice("unrelated-stream");
    expect(screen.queryByText(warning)).toBeNull();
    await notice("stream-2");
    expect(await screen.findByText(warning)).toBeTruthy();
  });
});
