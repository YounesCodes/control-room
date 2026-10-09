import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import * as fixtures from "./test/app-fixtures";
import type { AppSettings, HostBaseline, PersistedWorkspaceState } from "./types";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  save: vi.fn(),
  listeners: new Map<string, Set<(event: { payload: any }) => void>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  Channel: class {
    onmessage: ((message: any) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: any }) => void) => {
    const callbacks = native.listeners.get(name) ?? new Set();
    callbacks.add(handler);
    native.listeners.set(name, callbacks);
    return () => {
      callbacks.delete(handler);
    };
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn() }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.save, open: vi.fn() }));
import { App } from "./App";

let root: Root;
let element: HTMLDivElement;
let currentSettings: AppSettings;
let persisted: PersistedWorkspaceState;
let captures: HostBaseline[];
let sequence: number;
let streamOutput: { onmessage: (message: ArrayBuffer) => void } | null;
const failures = new Map<string, string>();
const overrides = new Map<string, (args: any) => any>();

function emit(name: string, payload: any) {
  native.listeners.get(name)?.forEach((callback) => callback({ payload }));
}

async function respond(command: string, args: any = {}) {
  if (failures.has(command)) throw new Error(failures.get(command));
  if (overrides.has(command)) return overrides.get(command)!(args);
  switch (command) {
    case "get_environment_info":
      return {
        sshPath: "fixture-ssh",
        sshConfigPath: "fixture-config",
        sshAgentAvailable: false,
        platformSupported: true,
      };
    case "list_connections":
      return [fixtures.connection(), fixtures.connection("host-b")];
    case "list_connection_groups":
    case "list_connection_tags":
      return [];
    case "list_local_shells":
      return {
        profiles: [
          {
            id: "command-prompt",
            label: "Command Prompt",
            kind: "command-prompt",
            elevated: false,
          },
        ],
        administratorStatus: "disabled",
      };
    case "get_settings_contract":
      return {
        current: currentSettings,
        defaults: fixtures.settings,
        logTailOptions: [50, 100, 200, 500, 1000],
      };
    case "save_settings":
      currentSettings = args.settings;
      return;
    case "get_workspace_state":
      return persisted;
    case "save_workspace_state":
      persisted = args.state;
      return;
    case "current_app_version":
      return "0.8.2";
    case "pending_update_notice":
    case "check_for_update":
      return null;
    case "get_cached_capabilities":
    case "refresh_capabilities":
      return fixtures.capabilities(args.connectionId);
    case "sample_host_resources":
      return fixtures.resources();
    case "start_session":
    case "start_local_session": {
      const sessionId = `session-${++sequence}`;
      setTimeout(() => {
        emit("session-state-changed", { sessionId, state: "connected", reason: null });
        args.output.onmessage(new TextEncoder().encode("fixture$ ").buffer);
      }, 0);
      return { sessionId, connectionId: args.connectionId, shellId: args.shellId };
    }
    case "resize_session":
    case "acknowledge_session_output":
    case "close_session":
    case "write_session":
      return;
    case "list_services":
      return [fixtures.service, fixtures.failedService];
    case "list_containers":
      return [fixtures.container];
    case "inspect_container":
      return fixtures.containerDetails;
    case "list_ports":
      return [fixtures.socket];
    case "inspect_firewall":
      return {
        available: false,
        active: null,
        defaultIncoming: null,
        rules: [],
        collectedAt: new Date().toISOString(),
      };
    case "inspect_connections":
      return {
        groups: [],
        totalEstablished: 0,
        truncated: false,
        collectedAt: new Date().toISOString(),
      };
    case "collect_boot_diagnostics":
      return { ...fixtures.boot(), selectedBootId: args.bootId ?? "a".repeat(32) };
    case "start_journal_stream":
    case "start_docker_log_stream":
      streamOutput = args.output;
      return { streamId: `stream-${++sequence}` };
    case "stop_log_stream":
      return;
    case "get_history_integration_status":
      return true;
    case "get_history":
      return [];
    case "get_scratchpad_note":
      return null;
    case "save_scratchpad_note":
      return { ...args.input, id: "note", createdAt: "", updatedAt: "" };
    case "list_host_baselines":
      return captures.map(fixtures.summary);
    case "get_host_baseline":
      return captures.find((capture) => capture.id === args.id);
    case "capture_host_baseline": {
      const capture = fixtures.baseline(
        `capture-${++sequence}`,
        args.request.label ?? "New baseline",
      );
      captures.unshift(capture);
      args.progress.onmessage({
        captureId: args.request.captureId,
        kind: "host",
        status: "collected",
        message: null,
        completed: 1,
        total: 1,
      });
      return fixtures.summary(capture);
    }
    case "cancel_host_baseline":
      return;
    case "rename_host_baseline": {
      const capture = captures.find((capture) => capture.id === args.id)!;
      capture.label = args.label;
      return fixtures.summary(capture);
    }
    case "set_host_baseline_pinned": {
      const capture = captures.find((capture) => capture.id === args.id)!;
      capture.pinned = args.pinned;
      return fixtures.summary(capture);
    }
    case "delete_host_baseline":
      captures = captures.filter((capture) => capture.id !== args.id);
      return;
    case "compare_host_baselines":
      return fixtures.comparison(
        captures.find((capture) => capture.id === args.baseId)!,
        captures.find((capture) => capture.id === args.targetId)!,
      );
    case "compare_host_baseline_with_live":
      return fixtures.comparison(
        captures.find((capture) => capture.id === args.baseId)!,
        fixtures.baseline("live", "Live state"),
        true,
      );
    case "open_documentation":
    case "export_text_file":
      return;
    default:
      throw new Error(`Missing typed fixture for ${command}`);
  }
}

async function mount() {
  root.render(<App />);
  await expect.element(page.getByRole("navigation", { name: "Saved connections" })).toBeVisible();
  await page
    .getByRole("button", { name: /Fixture Alpha/ })
    .first()
    .click();
  await expect.element(page.getByRole("navigation", { name: "Workspace features" })).toBeVisible();
}
async function navigate(name: string) {
  await page
    .getByRole("navigation", { name: "Workspace features" })
    .getByRole("button", { name, exact: true })
    .click();
}

beforeEach(async () => {
  await page.viewport(1180, 700);
  failures.clear();
  overrides.clear();
  native.listeners.clear();
  native.invoke.mockReset();
  native.save.mockReset();
  sequence = 0;
  streamOutput = null;
  currentSettings = { ...fixtures.settings };
  captures = [fixtures.baseline("stored", "Stored baseline")];
  persisted = { workspaces: [], activeWorkspaceId: null, terminalGroups: [], terminalLayout: null };
  native.invoke.mockImplementation(respond);
  element = document.createElement("div");
  element.style.height = "100vh";
  document.body.append(element);
  root = createRoot(element);
});
afterEach(() => {
  root.unmount();
  element.remove();
  window.localStorage.clear();
});

describe("complete app journeys with typed IPC fixtures", () => {
  it("opens documentation by keyboard in normal, focus and Settings modes at minimum width", async () => {
    await page.viewport(960, 640);
    await mount();
    const docs = page.getByRole("button", { name: "Open documentation", exact: true });
    await expect.element(docs).toHaveAttribute("title", "Documentation (opens in your browser)");
    const settingsButton = page.getByRole("button", { name: "Open Settings" }).element();
    expect(docs.element().nextElementSibling).toBe(settingsButton);
    for (const mode of ["normal", "focus", "settings"]) {
      if (mode === "focus")
        await page.getByRole("button", { name: "Focus terminal", exact: true }).click();
      if (mode === "settings") {
        await page.getByRole("button", { name: "Exit terminal focus", exact: true }).click();
        await page.getByRole("button", { name: "Open Settings" }).click();
      }
      await expect.element(docs).toBeVisible();
      expect(element.querySelectorAll('[aria-label="Open documentation"]')).toHaveLength(1);
      (docs.element() as HTMLButtonElement).focus();
      await userEvent.keyboard("{Enter}");
      await expect
        .poll(
          () =>
            native.invoke.mock.calls.filter(([command]) => command === "open_documentation").length,
        )
        .toBe(["normal", "focus", "settings"].indexOf(mode) + 1);
      await expect.element(docs).toBeEnabled();
      const bounds = docs.element().getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(960);
      for (const name of ["Minimize window", "Maximize or restore window", "Close window"]) {
        const control = page.getByRole("button", { name, exact: true });
        await expect.element(control).toBeVisible();
        const controlBounds = control.element().getBoundingClientRect();
        expect(controlBounds.left).toBeGreaterThanOrEqual(bounds.right);
        expect(controlBounds.right).toBeLessThanOrEqual(960);
        expect(controlBounds.top).toBeGreaterThanOrEqual(0);
        expect(controlBounds.bottom).toBeLessThanOrEqual(640);
      }
      const toolbar = mode === "focus" ? ".session-tab-actions" : ".app-bar";
      const result = await axe.run(element.querySelector(toolbar)!, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      });
      expect(result.violations.map(({ id }) => id)).toEqual([]);
    }
    await page.screenshot({ path: "../test-results/documentation-settings.png" });
  });

  it("checks updates manually, treats release notes as text and recovers from a download failure", async () => {
    overrides.set("check_for_update", () => ({
      currentVersion: "0.8.2",
      version: "9.9.9",
      notes: "<img src=x onerror=alert(1)> Fixture release",
      publishedAt: null,
    }));
    await mount();
    await page.getByRole("button", { name: "Open Settings" }).click();
    await page.getByRole("button", { name: "Check for updates" }).click();
    await page.getByRole("button", { name: "Close Settings", exact: true }).click();
    await page.getByRole("button", { name: /Control Room 9.9.9/ }).click();
    await expect
      .element(page.getByText(/<img src=x onerror=alert\(1\)> Fixture release/))
      .toBeVisible();
    expect(element.querySelector(".update-panel img")).toBeNull();
    failures.set("download_update", "fixture download failed");
    await page.getByRole("button", { name: "Download update" }).click();
    await expect.element(page.getByText(/fixture download failed/)).toBeVisible();
    failures.delete("download_update");
    let finish!: () => void;
    overrides.set("download_update", (args) => {
      args.progress.onmessage({ event: "started", contentLength: 100 });
      args.progress.onmessage({ event: "progress", downloaded: 50, total: 100 });
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await page.getByRole("button", { name: "Try again" }).click();
    await expect
      .element(page.getByRole("progressbar", { name: "Downloading Control Room 9.9.9" }))
      .toHaveAttribute("aria-valuenow", "50");
    finish();
    await expect
      .element(page.getByRole("button", { name: "Restart to update to Control Room 9.9.9" }))
      .toBeVisible();
    expect(native.invoke.mock.calls.some(([command]) => command === "install_update")).toBe(false);
  });
  it("pauses Logs rendering, searches, wraps and follows unread output", async () => {
    await mount();
    await navigate("Logs");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect.element(page.getByText("Stream active", { exact: true })).toBeVisible();
    streamOutput!.onmessage(
      new TextEncoder().encode(
        Array.from({ length: 120 }, (_, index) => `line ${index}`).join("\n") + "\n",
      ).buffer,
    );
    await expect.element(page.getByText(/line 119/)).toBeVisible();
    const output = element.querySelector(".log-output") as HTMLElement;
    output.scrollTop = 0;
    output.dispatchEvent(new Event("scroll", { bubbles: true }));
    streamOutput!.onmessage(new TextEncoder().encode("UNREAD_NEW_LINE\n").buffer);
    await expect.element(page.getByRole("button", { name: /Jump to latest.*new/ })).toBeVisible();
    await page.getByRole("button", { name: /Jump to latest/ }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    streamOutput!.onmessage(new TextEncoder().encode("PAUSED_LINE\n").buffer);
    await expect.element(page.getByText(/PAUSED_LINE/)).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect.element(page.getByText(/PAUSED_LINE/)).toBeVisible();
    await page.getByPlaceholder("Search loaded lines").fill("PAUSED_LINE");
    await expect.element(page.getByText(/PAUSED_LINE/)).toBeVisible();
    await vi.waitFor(() => expect(output.textContent).not.toContain("line 119"));
    const wrapped = output.classList.contains("log-output-wrapped");
    await page.getByRole("button", { name: "Wrap lines" }).click();
    expect(output.classList.contains("log-output-wrapped")).toBe(!wrapped);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("combobox", { name: "Source", exact: true }).selectOptions("docker");
    await expect
      .element(page.getByRole("combobox", { name: "Container", exact: true }))
      .toHaveValue(fixtures.container.id);
  });

  it("recovers from a log stream error and ignores stopped-stream output", async () => {
    await mount();
    await navigate("Logs");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect.element(page.getByText("Stream active", { exact: true })).toBeVisible();
    const old = streamOutput!;
    const start = native.invoke.mock.calls.find(([command]) => command === "start_journal_stream")!;
    expect(start[1].lines).toBe(fixtures.settings.defaultLogTail);
    emit("stream-state-changed", {
      streamId: `stream-${sequence}`,
      state: "error",
      reason: "fixture stream disconnected",
    });
    await expect
      .element(page.getByText("fixture stream disconnected", { exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect.element(page.getByText("Stream active", { exact: true })).toBeVisible();
    old.onmessage(new TextEncoder().encode("OLD_STREAM_OUTPUT\n").buffer);
    streamOutput!.onmessage(new TextEncoder().encode("RECOVERED_STREAM_OUTPUT\n").buffer);
    await expect.element(page.getByText(/RECOVERED_STREAM_OUTPUT/)).toBeVisible();
    await expect.element(page.getByText(/OLD_STREAM_OUTPUT/)).not.toBeInTheDocument();
  });

  it("pastes a saved History command into the connected terminal without execution", async () => {
    overrides.set("get_history", () => [
      {
        id: "history-a",
        connectionId: "host-a",
        sessionId: "old-session",
        command: "printf safe",
        cwd: "/",
        startedAt: "2026-09-01T00:00:00Z",
        finishedAt: null,
        exitCode: 0,
        shell: "bash",
      },
    ]);
    await mount();
    await navigate("History");
    await userEvent.hover(page.getByText("printf safe", { exact: true }));
    await page.getByRole("button", { name: "Paste into terminal" }).click();
    await vi.waitFor(() =>
      expect(native.invoke.mock.calls.some(([command]) => command === "write_session")).toBe(true),
    );
    const data = native.invoke.mock.calls.find(([command]) => command === "write_session")![1].data;
    expect(new TextDecoder().decode(new Uint8Array(data))).toBe("printf safe");
    await expect.element(page.getByRole("button", { name: "Find in terminal" })).toBeVisible();
  });

  it.each([960, 1600])(
    "gives Settings the full window at %s pixels and restores its workspace",
    async (width) => {
      await page.viewport(width, 640);
      await mount();
      await navigate("Terminal");
      const workspace = page.getByRole("navigation", { name: "Open Workspaces" }).element();
      const sessionCount = native.invoke.mock.calls.filter(
        ([command]) => command === "start_session",
      ).length;
      await page.getByRole("button", { name: "Open Settings", exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Close Settings" })).toBeVisible();
      const shell = element.querySelector(".app-shell")!.getBoundingClientRect();
      const titlebar = element.querySelector(".app-bar")!.getBoundingClientRect();
      const settings = element.querySelector(".settings-page")!.getBoundingClientRect();
      const form = element.querySelector(".settings-form")!.getBoundingClientRect();
      expect(settings.left).toBe(shell.left + 1);
      expect(settings.right).toBe(shell.right - 1);
      expect(settings.top).toBe(titlebar.bottom);
      expect(settings.bottom).toBe(shell.bottom - 1);
      expect(form.width).toBeGreaterThan(width - 100);
      expect(getComputedStyle(element.querySelector(".sidebar")!).display).toBe("none");
      expect(getComputedStyle(workspace).display).toBe("none");
      for (const name of ["Minimize window", "Maximize or restore window", "Close window"]) {
        await expect.element(page.getByRole("button", { name })).toBeVisible();
      }
      if (width === 1600) {
        await page.screenshot({ path: "../test-results/settings-full-window.png" });
      }
      const body = element.querySelector<HTMLElement>(".settings-body")!;
      body.scrollTop = body.scrollHeight;
      await expect.element(page.getByRole("button", { name: "Save settings" })).toBeVisible();
      await page.getByRole("button", { name: "Close Settings" }).click();
      await expect
        .element(page.getByRole("navigation", { name: "Saved connections" }))
        .toBeVisible();
      await expect.element(page.getByRole("navigation", { name: "Open Workspaces" })).toBeVisible();
      expect(page.getByRole("navigation", { name: "Open Workspaces" }).element()).toBe(workspace);
      expect(
        native.invoke.mock.calls.filter(([command]) => command === "start_session"),
      ).toHaveLength(sessionCount);
    },
  );

  it("keeps window controls available in Settings opened from terminal focus", async () => {
    await mount();
    await navigate("Terminal");
    await page.getByRole("button", { name: "Focus terminal", exact: true }).click();
    await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    await page.getByRole("combobox", { name: "Search commands" }).fill("settings");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("button", { name: "Close Settings" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Close window" })).toBeVisible();
    await page.getByRole("button", { name: "Close Settings" }).click();
    await expect.element(page.getByRole("button", { name: "Exit terminal focus" })).toBeVisible();
    expect(element.querySelector(".app-shell")!.classList.contains("terminal-focus-mode")).toBe(
      true,
    );
  });

  it("keeps Settings edits after a save failure and retries at minimum window size", async () => {
    await page.viewport(960, 640);
    await mount();
    await page.getByRole("button", { name: "Open Settings", exact: true }).click();
    await page.getByLabelText("Font size", { exact: true }).fill("18");
    failures.set("save_settings", "fixture disk full");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect.element(page.getByText(/fixture disk full/)).toBeVisible();
    await expect.element(page.getByLabelText("Font size", { exact: true })).toHaveValue(18);
    failures.delete("save_settings");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await vi.waitFor(() => expect(currentSettings.terminalFontSize).toBe(18));
    expect(element.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it("applies hidden shell settings to the sidebar, new terminal, split menu and palette", async () => {
    await mount();
    await page.getByRole("button", { name: "Open Settings", exact: true }).click();
    await page.getByRole("checkbox", { name: /Command Prompt/ }).click();
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await vi.waitFor(() => expect(currentSettings.hiddenLocalShells).toEqual(["command-prompt"]));
    await page.getByRole("button", { name: "Close Settings", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Local terminal", exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "New terminal", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: /Command Prompt/ }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await page.getByRole("button", { name: "Focus terminal", exact: true }).click();
    await page.getByRole("button", { name: "Split terminal", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: /Command Prompt/ }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await page.getByRole("button", { name: "Exit terminal focus", exact: true }).click();
    await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    await page.getByRole("combobox", { name: "Search commands" }).fill("Command Prompt");
    await expect
      .element(page.getByRole("option", { name: /Command Prompt/ }))
      .not.toBeInTheDocument();
    expect(
      native.invoke.mock.calls.filter(([command]) => command === "start_session"),
    ).toHaveLength(1);
  });

  it("reports unsupported Docker and limited boot journal evidence", async () => {
    overrides.set("refresh_capabilities", () => ({
      ...fixtures.capabilities(),
      dockerAvailable: false,
      dockerAccessible: false,
    }));
    overrides.set("get_cached_capabilities", () => ({
      ...fixtures.capabilities(),
      dockerAvailable: false,
      dockerAccessible: false,
    }));
    overrides.set("collect_boot_diagnostics", () => ({
      ...fixtures.boot(),
      journal: {
        data: null,
        collectedAt: "",
        error: "permission denied",
        permissionRequired: true,
      },
    }));
    failures.set("list_containers", "Docker is not installed on this host");
    await mount();
    await navigate("Docker");
    await expect
      .element(page.getByText(/Docker.*not.*(?:installed|available|detected)/i))
      .toBeVisible();
    await navigate("Boot");
    await expect.element(page.getByText(/permission denied/)).toBeVisible();
  });
  it("navigates every remote page through the real app and keeps the terminal Workspace", async () => {
    await mount();
    for (const [view, heading] of [
      ["Overview", "Overview"],
      ["Systemd", "Systemd"],
      ["Docker", "Containers"],
      ["Ports", "Ports"],
      ["Boot", "Boot Diagnostics"],
      ["Logs", "Logs"],
      ["Baselines", "Baselines"],
      ["History", "Enhanced History"],
      ["Scratchpad", "Scratchpad"],
    ]) {
      await navigate(view);
      await expect.element(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }
    await navigate("Terminal");
    await expect.element(page.getByRole("button", { name: "Find in terminal" })).toBeVisible();
    expect(
      native.invoke.mock.calls.filter(([command]) => command === "start_session"),
    ).toHaveLength(1);
  });

  it("filters Systemd, selects a unit, follows its journal and cleans up its stream on navigation", async () => {
    await mount();
    await navigate("Systemd");
    await page.getByRole("combobox", { name: "Unit state" }).selectOptions("failed");
    await page.getByRole("button", { name: /failed.service/ }).click();
    await page.getByRole("button", { name: "View journal" }).click();
    await expect
      .element(page.getByRole("combobox", { name: "Unit", exact: true }))
      .toHaveValue("failed.service");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect.element(page.getByText("Stream active", { exact: true })).toBeVisible();
    streamOutput!.onmessage(new TextEncoder().encode("journal fixture line\n").buffer);
    await expect.element(page.getByText(/journal fixture line/)).toBeVisible();
    await navigate("Overview");
    await vi.waitFor(() =>
      expect(native.invoke.mock.calls.some(([command]) => command === "stop_log_stream")).toBe(
        true,
      ),
    );
  });

  it("opens Docker details, hides filtered selection and follows container logs", async () => {
    await mount();
    await navigate("Docker");
    await page.getByRole("button", { name: /fixture-web/ }).click();
    await expect
      .element(page.getByRole("heading", { name: "fixture-web", exact: true }))
      .toBeVisible();
    await page.getByPlaceholder("Search projects, services, or containers").fill("missing");
    await expect
      .element(page.getByRole("heading", { name: "fixture-web", exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Clear search" }).click();
    await page.getByRole("button", { name: "View logs" }).click();
    await expect
      .element(page.getByRole("combobox", { name: "Container", exact: true }))
      .toHaveValue(fixtures.container.id);
  });

  it("follows a known port owner to Systemd and reads connection and firewall uncertainty", async () => {
    await mount();
    await navigate("Ports");
    await page.getByRole("tab", { name: "Table" }).click();
    await page.getByRole("button", { name: /443/ }).click();
    await page.getByRole("button", { name: /Open unit/ }).click();
    await expect
      .element(page.getByRole("heading", { name: fixtures.service.id, exact: true }))
      .toBeVisible();
    await navigate("Ports");
    await page.getByRole("tab", { name: "Connections" }).click();
    await expect.element(page.getByText(/No established/)).toBeVisible();
  });

  it("reads previous boot evidence and follows a current failed unit to Logs", async () => {
    await mount();
    await navigate("Boot");
    await page.getByRole("combobox", { name: "Boot", exact: true }).selectOptions("b".repeat(32));
    await vi.waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        "collect_boot_diagnostics",
        expect.objectContaining({ bootId: "b".repeat(32) }),
      ),
    );
    await page.getByRole("combobox", { name: "Boot", exact: true }).selectOptions("a".repeat(32));
    await page.getByRole("button", { name: /View journal/ }).click();
    await expect.element(page.getByRole("heading", { name: "Logs", exact: true })).toBeVisible();
  });

  it("reports refresh failure, keeps existing Systemd data and recovers", async () => {
    await mount();
    await navigate("Systemd");
    await expect.element(page.getByRole("button", { name: /fixture.service/ })).toBeVisible();
    failures.set("list_services", "Fixture network failure");
    await page.getByRole("button", { name: "Refresh systemd units", exact: true }).click();
    await expect.element(page.getByText(/Refresh failed: Fixture network failure/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: /fixture.service/ })).toBeVisible();
    failures.delete("list_services");
    await page.getByRole("button", { name: "Refresh systemd units", exact: true }).click();
    await expect
      .element(page.getByText(/Refresh failed: Fixture network failure/))
      .not.toBeInTheDocument();
  });

  it("cancels one-shot sudo and retries only the requested firewall read", async () => {
    failures.set("inspect_firewall", "Permission denied");
    await mount();
    await navigate("Ports");
    await page.getByRole("button", { name: "Retry with sudo" }).click();
    await expect.element(page.getByRole("dialog", { name: "Sudo required" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(
      native.invoke.mock.calls.filter(
        ([command, args]) => command === "inspect_firewall" && args.sudoPassword,
      ),
    ).toHaveLength(0);
    await page.getByRole("button", { name: "Retry with sudo" }).click();
    failures.delete("inspect_firewall");
    await page.getByLabelText(/Password/).fill("fixture-password");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await vi.waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("inspect_firewall", {
        connectionId: "host-a",
        sudoPassword: "fixture-password",
      }),
    );
    expect(currentSettings.globalSudoEnabled).toBe(false);
  });

  it("captures, renames with cancellation and save recovery, pins and compares before deleting a baseline", async () => {
    await mount();
    await navigate("Baselines");
    await page.getByRole("textbox", { name: "Baseline label" }).fill("Browser capture");
    await page.getByRole("button", { name: "Capture baseline", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Pin baseline" })).toBeVisible();
    await page.getByRole("button", { name: "Rename baseline", exact: true }).click();
    await page.getByRole("textbox", { name: "Baseline label" }).nth(1).fill("Discarded rename");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "Browser capture", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Rename baseline", exact: true }).click();
    await page.getByRole("textbox", { name: "Baseline label" }).nth(1).fill("Renamed capture");
    failures.set("rename_host_baseline", "fixture rename failed");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.element(page.getByText("fixture rename failed", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("textbox", { name: "Baseline label" }).nth(1))
      .toHaveValue("Renamed capture");
    failures.delete("rename_host_baseline");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "Renamed capture", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Pin baseline" }).click();
    await expect.element(page.getByRole("button", { name: "Unpin baseline" })).toBeVisible();
    const count = captures.length;
    await page.getByRole("combobox").selectOptions("live");
    await expect.element(page.getByText(/This read was not saved/)).toBeVisible();
    expect(captures).toHaveLength(count);
    await page.getByRole("button", { name: "Delete baseline", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(captures).toHaveLength(count);
    await page.getByRole("button", { name: "Delete baseline", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete baseline", exact: true })
      .click();
    await vi.waitFor(() => expect(captures).toHaveLength(count - 1));
  });

  it("drives the app command palette with a keyboard and checks the Settings page with axe", async () => {
    await mount();
    await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    await page.getByRole("combobox", { name: "Search commands" }).fill("settings");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("heading", { name: "Settings", exact: true }))
      .toBeVisible();
    const result = await axe.run(element, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });
});
