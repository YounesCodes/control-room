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

function expectTerminalMenuAlignment(menu: Element) {
  for (const row of menu.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
    const icon = row.querySelector<HTMLElement>(".session-tab-menu-icon")!;
    const name = row.querySelector<HTMLElement>(".session-tab-menu-name")!;
    const check = row.querySelector<HTMLElement>(".session-tab-menu-check")!;
    expect(row.firstElementChild).toBe(icon);
    expect(row.lastElementChild).toBe(check);
    const bounds = row.getBoundingClientRect();
    expect(icon.getBoundingClientRect().left).toBeCloseTo(bounds.left + 8, 0);
    expect(check.getBoundingClientRect().right).toBeCloseTo(bounds.right - 8, 0);
    expect(check.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      name.getBoundingClientRect().right,
    );
  }
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
    case "sample_header_metrics":
      return {
        sampledAt: new Date().toISOString(),
        cpuPercent: args.connectionId === null ? 42 : 12,
        memoryTotalKib: 4096,
        memoryAvailableKib: 2048,
        gpuPercent: null,
        diskTotalKib: 8192,
        diskFreeKib: 2048,
        diskLabel: args.connectionId === null ? "C:" : "/",
        uptimeSeconds: 90000,
      };
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
  it("colors local terminal identities on hover, focus, and selection in both layouts", async () => {
    await page.viewport(960, 640);
    overrides.set("list_local_shells", () => ({
      profiles: [
        { id: "command-prompt", label: "Command Prompt", kind: "command-prompt", elevated: false },
        { id: "git-bash", label: "Git Bash", kind: "git-bash", elevated: false },
      ],
      administratorStatus: "disabled",
    }));
    await mount();
    const blue = "rgb(83, 145, 254)";
    const neutral = "rgb(173, 173, 170)";
    const color = (mark: Element) => getComputedStyle(mark).color;
    const launcher = page.getByRole("button", { name: "Local terminal", exact: true });
    const launcherMark = launcher.element().querySelector(".local-shell-mark")!;
    await expect.poll(() => color(launcherMark)).toBe(neutral);
    await userEvent.hover(launcher.element());
    await expect.poll(() => color(launcherMark)).toBe(blue);
    await launcher.click();
    await userEvent.hover(page.getByRole("button", { name: "Find in terminal" }).element());
    await expect.poll(() => color(launcherMark)).toBe(blue);
    const choice = page.getByRole("menuitem", { name: "Command Prompt", exact: true });
    await userEvent.hover(choice.element());
    await expect.poll(() => color(choice.element().querySelector(".local-shell-mark")!)).toBe(blue);
    await choice.click();
    const local = page.getByRole("button", { name: "Command Prompt", exact: true });
    const tab = local.element().closest(".session-tab-wrap")!;
    const mark = tab.querySelector(".local-shell-mark")!;
    await expect.poll(() => color(mark)).toBe(blue);
    const host = page
      .getByRole("navigation", { name: "Saved connections" })
      .getByRole("button", { name: /^(Ubuntu host )?Fixture Alpha/ });
    await host.click();
    await expect.poll(() => color(mark)).toBe(neutral);
    await userEvent.hover(local.element());
    await expect.poll(() => color(mark)).toBe(blue);
    await userEvent.hover(host.element());
    await expect.poll(() => color(mark)).toBe(neutral);
    (local.element() as HTMLButtonElement).focus();
    await expect.poll(() => color(mark)).toBe(blue);
    await userEvent.keyboard("{Enter}");
    await page.getByRole("button", { name: "Focus terminal", exact: true }).click();
    await expect.poll(() => color(mark)).toBe(blue);
    await page.getByRole("button", { name: "Split terminal", exact: true }).click();
    const splitChoice = page.getByRole("button", {
      name: "New local terminal: Git Bash",
      exact: true,
    });
    await userEvent.hover(splitChoice.element());
    await expect
      .poll(() => color(splitChoice.element().querySelector(".local-shell-mark")!))
      .toBe(blue);
    await splitChoice.click();
    const pane = page
      .getByRole("navigation", { name: /Terminals in .* group/ })
      .getByRole("button", { name: "Command Prompt", exact: true });
    const paneMark = pane.element().querySelector(".local-shell-mark")!;
    await userEvent.hover(page.getByRole("button", { name: "Find in terminal" }).element());
    await expect.poll(() => color(paneMark)).toBe(neutral);
    await userEvent.hover(pane.element());
    await expect.poll(() => color(paneMark)).toBe(blue);
    await pane.click();
    await expect.poll(() => color(paneMark)).toBe(blue);
    await page.screenshot({ path: "../test-results/local-terminal-identity-focus.png" });
    await page.getByRole("button", { name: "Exit terminal focus", exact: true }).click();
    await expect.poll(() => color(local.element().querySelector(".local-shell-mark")!)).toBe(blue);
    await page.screenshot({ path: "../test-results/local-terminal-identity-normal.png" });
    for (let index = 0; index < 5; index++) {
      await page.getByRole("button", { name: "New terminal", exact: true }).click();
      await page
        .getByRole("dialog", { name: "New terminal" })
        .getByRole("button", { name: /Command Prompt/ })
        .click();
    }
    await page.getByRole("button", { name: "All terminals", exact: true }).click();
    const menu = page.getByRole("menu", { name: "All terminals" }).element();
    await expect
      .poll(() => color(menu.querySelector('[aria-current="page"] .local-shell-icon')!))
      .toBe(blue);
    const git = page.getByRole("menuitem", { name: /^Git Bash/ });
    await userEvent.hover(git.element());
    await expect.poll(() => color(git.element().querySelector(".local-shell-icon")!)).toBe(blue);
  });

  it("spins during commands and host reads, including grouped panes, and keeps errors circular", async () => {
    await mount();
    await navigate("Terminal");
    await expect.element(page.getByText("fixture$", { exact: true })).toBeVisible();
    const started = native.invoke.mock.calls.find(([command]) => command === "start_session")![1];
    const output = (text: string) =>
      started.output.onmessage(new TextEncoder().encode(text).buffer);
    const idle = element.querySelector<HTMLElement>(".host-row.active .presence")!;
    expect(getComputedStyle(idle).borderRadius).toBe("50%");
    expect(idle.classList.contains("presence-busy")).toBe(false);

    await userEvent.click(
      element.querySelector<HTMLElement>(".terminal-workspace-pane.active .xterm-screen")!,
    );
    await userEvent.keyboard("sleep 60{Enter}");
    output("\r\n");
    await vi.waitFor(() =>
      expect(element.querySelector(".host-row.active .presence-busy")).not.toBeNull(),
    );
    const ring = element.querySelector<HTMLElement>(".session-tab-wrap.active .presence-busy")!;
    expect(getComputedStyle(ring).animationName).toBe("spin");
    expect(ring.offsetWidth).toBe(8);
    await page.screenshot({ path: "../test-results/processing-terminal.png" });

    await page.getByRole("button", { name: "Focus terminal", exact: true }).click();
    await page.getByRole("button", { name: "Split terminal", exact: true }).click();
    await page.getByRole("button", { name: /^Split vertically/ }).click();
    await page
      .getByRole("button", { name: "New local terminal: Command Prompt", exact: true })
      .click();
    await vi.waitFor(() => {
      expect(element.querySelector(".session-tab-group-main .presence-busy")).not.toBeNull();
      expect(element.querySelector(".session-pane-tabs .presence-busy")).not.toBeNull();
    });
    await page.screenshot({ path: "../test-results/processing-focus.png" });
    output("done\r\nfixture$ ");
    await vi.waitFor(() => expect(element.querySelector(".presence-busy")).toBeNull());

    emit("session-state-changed", {
      sessionId: "session-1",
      state: "error",
      reason: "Fixture connection lost",
    });
    await vi.waitFor(() =>
      expect(element.querySelector(".session-pane-tabs .presence-error")).not.toBeNull(),
    );
    const error = element.querySelector<HTMLElement>(".session-pane-tabs .presence-error")!;
    expect(getComputedStyle(error).borderRadius).toBe("50%");
    expect(error.classList.contains("presence-busy")).toBe(false);
    await page.screenshot({ path: "../test-results/processing-error-circle.png" });
  });

  it("keeps host reads spinning until all concurrent requests settle", async () => {
    await mount();
    let finish!: () => void;
    let fail!: (error: Error) => void;
    overrides.set(
      "list_services",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    overrides.set(
      "list_ports",
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const { api } = await import("./lib/api");
    const hostId = fixtures.connection().id;
    const services = api.listServices(hostId);
    const ports = api.listPorts(hostId).catch(() => undefined);
    await vi.waitFor(() =>
      expect(element.querySelector(".host-row.active .presence-busy")).not.toBeNull(),
    );
    finish();
    await services;
    expect(element.querySelector(".host-row.active .presence-busy")).not.toBeNull();
    fail(new Error("fixture read failed"));
    await ports;
    await vi.waitFor(() =>
      expect(element.querySelector(".host-row.active .presence-busy")).toBeNull(),
    );
  });

  it("selects overflowing terminals and group panes by full names without changing live sessions", async () => {
    await page.viewport(960, 640);
    const shellKinds = [
      "git-bash",
      "windows-powershell",
      "powershell-7",
      "command-prompt",
    ] as const;
    const shellLabels = ["Git Bash", "Windows PowerShell", "PowerShell 7", "Command Prompt"];
    overrides.set("list_local_shells", () => ({
      profiles: shellKinds.map((kind, index) => ({
        id: kind,
        kind,
        label: shellLabels[index],
        elevated: false,
      })),
      administratorStatus: "disabled",
    }));
    await mount();
    await navigate("Terminal");
    for (let index = 0; index < 7; index++) {
      await page.getByRole("button", { name: "New terminal", exact: true }).click();
      await page
        .getByRole("dialog", { name: "New terminal" })
        .getByRole("button", { name: new RegExp(shellLabels[Math.min(index, 3)]) })
        .click();
    }
    const sessions = native.invoke.mock.calls.filter(
      ([command]) => command === "start_session" || command === "start_local_session",
    ).length;
    await page.getByRole("button", { name: "All terminals", exact: true }).click();
    const terminalMenu = page.getByRole("menu", { name: "All terminals" }).element();
    expectTerminalMenuAlignment(terminalMenu);
    for (const kind of shellKinds) {
      expect(
        terminalMenu.querySelector(`.session-tab-menu-icon .local-shell-icon-${kind} svg`),
      ).not.toBeNull();
    }
    expect(terminalMenu.querySelector(".session-tab-menu-icon .host-os-ubuntu svg")).not.toBeNull();
    expect(
      terminalMenu.querySelector('[aria-current="page"] .session-tab-menu-check svg'),
    ).not.toBeNull();
    await page
      .getByRole("menu", { name: "All terminals" })
      .getByRole("menuitem", { name: /^Fixture Alpha/ })
      .click();
    await expect
      .element(page.getByRole("button", { name: /^(Ubuntu host )?Fixture Alpha$/ }))
      .toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "Focus terminal", exact: true }).click();
    for (let index = 0; index < 5; index++) {
      await page.getByRole("button", { name: "Split terminal", exact: true }).click();
      await page
        .getByRole("button", { name: "New local terminal: Command Prompt", exact: true })
        .click();
      if (index === 0) {
        const local = native.invoke.mock.calls
          .filter(([command]) => command === "start_local_session")
          .at(-1)!;
        local[1].output.onmessage(
          new TextEncoder().encode(
            "\r\nC:\\demo> npm run build\r\nBuild complete.\r\n\r\nC:\\demo> ",
          ).buffer,
        );
        await page.getByRole("button", { name: "All terminals", exact: true }).click();
        await page.screenshot({ path: "../test-results/terminal-overflow.png" });
        await userEvent.keyboard("{Escape}");
      }
    }
    await page.getByRole("button", { name: "Scroll terminals right" }).first().click();
    await page.getByRole("button", { name: "All terminals", exact: true }).click();
    const groupItem = page
      .getByRole("menu", { name: "All terminals" })
      .getByRole("menuitem", { name: /^Fixture Alpha group/ });
    await expect.element(groupItem).toHaveTextContent("Fixture Alpha group6 terminals");
    expectTerminalMenuAlignment(page.getByRole("menu", { name: "All terminals" }).element());
    expect(
      groupItem.element().querySelector(".session-tab-menu-icon .lucide-columns-2"),
    ).not.toBeNull();
    await groupItem.click();
    await expect
      .element(page.getByRole("button", { name: "Open Fixture Alpha group 6 terminals" }))
      .toBeVisible();
    await page.getByRole("button", { name: "All panes", exact: true }).click();
    const paneMenu = page.getByRole("menu", { name: "All panes" });
    expectTerminalMenuAlignment(paneMenu.element());
    expect(paneMenu.element().querySelectorAll('[role="menuitem"]')).toHaveLength(6);
    expect(
      paneMenu
        .element()
        .querySelectorAll(".session-tab-menu-icon .local-shell-icon-command-prompt svg"),
    ).toHaveLength(5);
    expect(
      paneMenu.element().querySelector(".session-tab-menu-icon .host-os-ubuntu svg"),
    ).not.toBeNull();
    await paneMenu.getByRole("menuitem", { name: /^Fixture Alpha/ }).click();
    await expect
      .element(page.getByRole("button", { name: /^(Ubuntu host )?Fixture Alpha$/ }))
      .toHaveAttribute("aria-current", "page");
    const panes = element.querySelectorAll<HTMLElement>(".terminal-workspace-pane-visible");
    expect(panes).toHaveLength(6);
    for (const list of element.querySelectorAll<HTMLElement>(".session-tab-list")) {
      const bounds = list.getBoundingClientRect();
      for (const tab of list.querySelectorAll<HTMLElement>(
        ".session-tab-wrap, .session-tab-group",
      )) {
        const rect = tab.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
        expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
      }
    }
    expect(
      native.invoke.mock.calls.filter(
        ([command]) => command === "start_session" || command === "start_local_session",
      ),
    ).toHaveLength(sessions + 5);
    expect(native.invoke.mock.calls.some(([command]) => command === "close_session")).toBe(false);
  });

  it("keeps grouped session state and activity visible and routes input to the selected pane", async () => {
    await mount();
    await navigate("Terminal");
    await vi.waitFor(() =>
      expect(native.invoke.mock.calls.some(([command]) => command === "start_session")).toBe(true),
    );
    const remote = native.invoke.mock.calls.find(([command]) => command === "start_session")![1]
      .output;
    remote.onmessage(
      new TextEncoder().encode(
        "\r\nexample@build-host:~$ git status\r\nOn branch main\r\nWorking tree clean\r\n\r\nexample@build-host:~$ ",
      ).buffer,
    );
    await page.screenshot({ path: "../test-results/terminal-header-normal.png" });
    await page.getByRole("button", { name: "Focus terminal", exact: true }).click();
    await page.getByRole("button", { name: "Split terminal", exact: true }).click();
    await page
      .getByRole("button", { name: "New local terminal: Command Prompt", exact: true })
      .click();
    await page.getByRole("button", { name: /^Rename .* group$/ }).click();
    await page
      .getByRole("dialog", { name: "Rename terminal group" })
      .getByRole("textbox")
      .fill("Build and logs");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const localCall = native.invoke.mock.calls.find(
      ([command]) => command === "start_local_session",
    )!;
    localCall[1].output.onmessage(
      new TextEncoder().encode("\r\nC:\\demo> npm run build\r\nBuild complete.\r\n\r\nC:\\demo> ")
        .buffer,
    );
    const group = page.getByRole("button", { name: "Open Build and logs 2 terminals" });
    await expect
      .element(group)
      .toHaveAccessibleDescription(/Fixture Alpha: connected.*Command Prompt: running/);
    await page.screenshot({ path: "../test-results/terminal-header-groups.png" });
    await page.getByRole("button", { name: "New terminal", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New terminal" })
      .getByRole("button", { name: /Command Prompt/ })
      .click();
    const remoteSession = "session-1";
    remote.onmessage(new TextEncoder().encode("\x07Background build complete\r\n").buffer);
    await expect.element(group).toHaveAccessibleDescription(/terminal bell/);
    expect(group.element().querySelector(".terminal-activity-bell")).not.toBeNull();
    emit("session-state-changed", {
      sessionId: remoteSession,
      state: "disconnected",
      reason: "Example session ended",
    });
    await expect.element(group).toHaveAccessibleDescription(/Fixture Alpha: disconnected/);
    expect(group.element().querySelector(".presence-disconnected")).not.toBeNull();
    await group.click();
    await page
      .getByRole("navigation", { name: "Terminals in Build and logs" })
      .getByRole("button", { name: "Command Prompt", exact: true })
      .click();
    await userEvent.click(
      element.querySelector<HTMLElement>(".terminal-workspace-pane.active .xterm-screen")!,
    );
    await userEvent.keyboard("echo pane");
    await vi.waitFor(() =>
      expect(
        native.invoke.mock.calls.filter(([command]) => command === "write_session").at(-1)![1]
          .sessionId,
      ).toBe("session-2"),
    );
    // Pane selection is also reflected in persisted state, so a later restore
    // and active-pane actions use the same terminal.
    await vi.waitFor(() =>
      expect(persisted.activeWorkspaceId).toBe(
        persisted.workspaces.find((workspace) => workspace.localShellId === "command-prompt")!.id,
      ),
    );
  });
  it("keeps metrics off by default, saves customization, and follows remote and local workspaces", async () => {
    await mount();
    expect(native.invoke.mock.calls.some(([name]) => name === "sample_header_metrics")).toBe(false);
    await page.getByRole("button", { name: "Open Settings" }).click();
    await page.getByRole("checkbox", { name: "Show host metrics in header" }).click();
    await page.getByRole("checkbox", { name: "GPU", exact: true }).click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.getByRole("button", { name: "Close Settings", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: /: Host metrics for Fixture Alpha$/ }))
      .toBeVisible();
    await expect.element(page.getByText("12%", { exact: true }).first()).toBeVisible();
    expect(element.querySelector(".host-metrics-values")!.textContent).not.toContain("GPU");
    await page.getByRole("button", { name: "Local terminal", exact: true }).click();
    await page.getByRole("button", { name: "Command Prompt", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: /: Host metrics for Local machine$/ }))
      .toBeVisible();
    await expect.element(page.getByText("42%", { exact: true })).toBeVisible();
    const call = native.invoke.mock.calls
      .filter(([name]) => name === "sample_header_metrics")
      .at(-1)!;
    expect(call[1]).toEqual({ connectionId: null, metrics: ["cpu", "ram", "disk", "uptime"] });
    await page.getByRole("button", { name: "Open Settings" }).click();
    expect(element.querySelector(".host-metrics")).toBeNull();
    await page.getByRole("checkbox", { name: "Show host metrics in header" }).click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.getByRole("button", { name: "Close Settings", exact: true }).click();
    expect(element.querySelector(".host-metrics")).toBeNull();
  });
  it("starts local readings while the previous SSH target is still pending and ignores its late reply", async () => {
    currentSettings = { ...currentSettings, hostMetricsEnabled: true };
    let finish!: (value: unknown) => void;
    const reading = {
      sampledAt: new Date().toISOString(),
      cpuPercent: 42,
      memoryTotalKib: 4096,
      memoryAvailableKib: 2048,
      gpuPercent: null,
      diskTotalKib: 8192,
      diskFreeKib: 2048,
      diskLabel: "C:",
      uptimeSeconds: 59,
    };
    overrides.set("sample_header_metrics", ({ connectionId }) =>
      connectionId === null
        ? reading
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    await mount();
    await expect.poll(() => typeof finish).toBe("function");
    await page.getByRole("button", { name: "Local terminal", exact: true }).click();
    await page.getByRole("button", { name: "Command Prompt", exact: true }).click();
    await expect.element(page.getByText("42%", { exact: true })).toBeVisible();
    finish({ ...reading, cpuPercent: 99 });
    await expect.element(page.getByText("42%", { exact: true })).toBeVisible();
    expect(element.querySelector(".host-metrics-values")!.textContent).not.toContain("99%");
  });
  it("marks a malformed timestamp stale, hides Invalid Date, and recovers on manual refresh", async () => {
    currentSettings = { ...currentSettings, hostMetricsEnabled: true };
    let sampledAt = "broken";
    overrides.set("sample_header_metrics", () => ({
      sampledAt,
      cpuPercent: 12,
      memoryTotalKib: 4096,
      memoryAvailableKib: 2048,
      gpuPercent: null,
      diskTotalKib: 8192,
      diskFreeKib: 2048,
      diskLabel: "/",
      uptimeSeconds: 59,
    }));
    await mount();
    await expect.element(page.getByText("Stale", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /: Host metrics for Fixture Alpha$/ }).click();
    await expect.element(page.getByText(/Last reading time Unavailable/)).toBeVisible();
    expect(element.querySelector(".host-metrics-panel")!.textContent).not.toContain("Invalid Date");
    sampledAt = new Date().toISOString();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.element(page.getByText("Live", { exact: true })).toBeVisible();
  });
  it("adds a keyboard tab stop only while the metric row overflows", async () => {
    currentSettings = { ...currentSettings, hostMetricsEnabled: true };
    await mount();
    const row = element.querySelector<HTMLDivElement>(".host-metrics-values")!;
    await expect.poll(() => row.scrollWidth > row.clientWidth).toBe(false);
    expect(row.getAttribute("tabindex")).toBeNull();
    const strip = element.querySelector<HTMLElement>(".host-metrics")!;
    strip.style.maxWidth = "340px";
    await expect.poll(() => row.getAttribute("tabindex")).toBe("0");
    await page.getByRole("button", { name: /: Host metrics for Fixture Alpha$/ }).click();
    await userEvent.keyboard("{Escape}{Tab}{ArrowRight}");
    await expect
      .element(page.getByRole("group", { name: "Current host readings. Scroll for more metrics." }))
      .toHaveFocus();
    await expect.poll(() => row.scrollLeft).toBeGreaterThan(0);
    strip.style.maxWidth = "";
    await expect.poll(() => row.getAttribute("tabindex")).toBeNull();
  });
  it("offers window drag targets across metric text and spacing while keeping details clickable", async () => {
    currentSettings = { ...currentSettings, hostMetricsEnabled: true };
    await mount();
    const strip = element.querySelector<HTMLElement>(".host-metrics")!;
    const row = strip.querySelector<HTMLElement>(".host-metrics-values")!;
    for (const target of [...row.querySelectorAll<HTMLElement>(".host-metric > *"), row, strip]) {
      const bounds = target.getBoundingClientRect();
      const x = target === strip ? bounds.right - 2 : bounds.left + 2;
      const y = target === row ? bounds.top + 2 : bounds.top + bounds.height / 2;
      const hit = document.elementFromPoint(x, y)!;
      expect(hit).toBe(target);
      expect(hit).toHaveAttribute("data-tauri-drag-region");
    }
    await page.getByRole("button", { name: /: Host metrics for Fixture Alpha$/ }).click();
    const panel = strip.querySelector<HTMLElement>(".host-metrics-panel")!;
    expect(panel.querySelector("[data-tauri-drag-region]")).toBeNull();
    await expect.element(page.getByRole("button", { name: "Close host metrics" })).toHaveFocus();
    await page.getByRole("button", { name: "Close host metrics" }).click();
    expect(strip.querySelector(".host-metrics-panel")).toBeNull();
  });
  for (const width of [840, 1440]) {
    it(`anchors the focus toggle beside window controls across modes and groups at ${width}px`, async () => {
      await page.viewport(width, 700);
      currentSettings = { ...currentSettings, hostMetricsEnabled: true };
      await mount();
      await navigate("Terminal");
      const button = page.getByRole("button", { name: "Focus terminal", exact: true });
      const original = button.element();
      const position = () => {
        const rect = original.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height];
      };
      const normalBounds = position();
      expect(normalBounds[0]).toBe(width - 179);
      expect(normalBounds[1]).toBe(1);
      await expect.element(button).toHaveAttribute("aria-pressed", "false");
      await page.screenshot({ path: `../test-results/focus-toggle-normal-${width}.png` });
      await button.click();
      const exit = page.getByRole("button", { name: "Exit terminal focus", exact: true });
      await expect.element(exit).toHaveAttribute("aria-pressed", "true");
      expect(exit.element()).toBe(original);
      expect(position()).toEqual(normalBounds);
      await expect.element(exit).toHaveFocus();
      expect(element.querySelectorAll('[aria-label="Close window"]')).toHaveLength(1);
      await expect.element(page.getByRole("button", { name: "Close window" })).toBeVisible();
      const closeBounds = page
        .getByRole("button", { name: "Close window" })
        .element()
        .getBoundingClientRect();
      expect(closeBounds.y).toBe(normalBounds[1]);
      expect(closeBounds.height).toBe(normalBounds[3]);
      expect(closeBounds.right).toBe(width - 1);
      const actions = element.querySelector(".app-window-actions")!;
      const strip = element.querySelector(".session-tabs")!;
      await expect
        .poll(() => element.querySelector(".session-tab-actions")!.getBoundingClientRect().right)
        .toBeLessThanOrEqual(actions.getBoundingClientRect().left);
      expect(strip.getBoundingClientRect().height).toBe(42);
      await page.screenshot({ path: `../test-results/focus-toggle-focus-${width}.png` });
      await page.getByRole("button", { name: "Split terminal", exact: true }).click();
      await page
        .getByRole("button", { name: "New local terminal: Command Prompt", exact: true })
        .click();
      await expect
        .element(page.getByRole("navigation", { name: /Terminals in .* group/ }))
        .toBeVisible();
      expect(position()).toEqual(normalBounds);
      for (let index = 0; index < 10; index++) {
        await page.getByRole("button", { name: "New terminal", exact: true }).click();
        await page
          .getByRole("dialog", { name: "New terminal" })
          .getByRole("button", { name: /Command Prompt/ })
          .click();
      }
      await expect
        .element(page.getByRole("button", { name: "All terminals", exact: true }))
        .toBeVisible();
      expect(position()).toEqual(normalBounds);
      expect(element.scrollWidth).toBeLessThanOrEqual(width);
      expect((await axe.run(actions)).violations).toEqual([]);
      await exit.click();
      await expect.element(button).toHaveAttribute("aria-pressed", "false");
      expect(button.element()).toBe(original);
      expect(position()).toEqual(normalBounds);
      await userEvent.keyboard("{Space>}");
      expect(position()).toEqual(normalBounds);
      await userEvent.keyboard("{/Space}");
      await expect.element(exit).toHaveAttribute("aria-pressed", "true");
      expect(position()).toEqual(normalBounds);
      await userEvent.keyboard("{Space}");
      await expect.element(button).toHaveAttribute("aria-pressed", "false");
      expect(position()).toEqual(normalBounds);
    });
  }

  it("keeps normal connection state in the sidebar and restores tab indicators in Focus Mode", async () => {
    await mount();
    const host = element.querySelector<HTMLElement>(".host-row.active")!;
    const tab = element.querySelector<HTMLElement>(".session-tab-wrap.active")!;
    await expect.poll(() => tab.dataset.sessionState).toBe("connected");
    const mark = host.querySelector<HTMLElement>(".target-mark")!;
    const presence = host.querySelector<HTMLElement>(".presence-connected")!;
    expect(mark.contains(presence)).toBe(false);
    expect(presence.getBoundingClientRect().left).toBeGreaterThan(
      mark.getBoundingClientRect().right,
    );
    expect(tab.querySelector(".presence")).toBeNull();
    expect(tab.querySelector(".sr-only")?.textContent).toBe("Terminal connected");
    await page.screenshot({ element: host, path: "../test-results/host-status-placement.png" });
    await page.screenshot({ element: tab, path: "../test-results/tab-status-placement.png" });
    expect((await axe.run(element.querySelector(".sidebar")!)).violations).toEqual([]);
    await page.getByRole("button", { name: "Focus terminal", exact: true }).click();
    await expect.poll(() => !!tab.querySelector(".presence-connected")).toBe(true);
    const focusMark = tab.querySelector<HTMLElement>(".target-mark")!;
    const focusPresence = tab.querySelector<HTMLElement>(".presence-connected")!;
    expect(focusMark.contains(focusPresence)).toBe(false);
    expect(focusPresence.getBoundingClientRect().left).toBeGreaterThan(
      focusMark.getBoundingClientRect().right,
    );
    await page.getByRole("button", { name: "Exit terminal focus", exact: true }).click();
    await expect.poll(() => tab.querySelector(".presence")).toBeNull();
  });

  for (const state of ["connecting", "disconnected", "error"]) {
    it(`keeps a tab indicator for a ${state} session`, async () => {
      await mount();
      const tab = element.querySelector<HTMLElement>(".session-tab-wrap.active")!;
      await expect.poll(() => tab.dataset.sessionState).toBe("connected");
      emit("session-state-changed", { sessionId: "session-1", state, reason: null });
      await expect.poll(() => !!tab.querySelector(`.presence-${state}`)).toBe(true);
      expect(tab.dataset.sessionState).toBe(state);
      expect(tab.querySelector(".target-mark")!.contains(tab.querySelector(".presence"))).toBe(
        false,
      );
    });
  }

  for (const width of [840, 1440]) {
    it(`keeps header actions reachable and metrics accessible at ${width}px`, async () => {
      currentSettings = {
        ...currentSettings,
        hostMetricsEnabled: true,
        hostMetricsIntervalSeconds: 2,
      };
      await page.viewport(width, 700);
      await mount();
      await page.getByRole("button", { name: /: Host metrics for Fixture Alpha$/ }).click();
      await expect.element(page.getByText("This host did not report a reading")).toBeVisible();
      const close = page.getByRole("button", { name: "Close host metrics" });
      await expect.element(close).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByRole("button", { name: /: Host metrics for Fixture Alpha$/ }))
        .toHaveFocus();
      const badge = element.querySelector(".host-metrics-status")!;
      expect(badge.parentElement).toHaveClass("host-metrics-trigger");
      expect(element.querySelector(".host-metrics")!.textContent).not.toContain("Fixture Alpha");
      expect(badge.parentElement?.getAttribute("title")).toContain("Fixture Alpha");
      expect(badge.getAttribute("aria-label")).toContain("latest host reading is current");
      expect(badge.getBoundingClientRect().right).toBeLessThanOrEqual(
        element.querySelector(".host-metrics-values")!.getBoundingClientRect().left,
      );
      const metrics = element.querySelector(".host-metrics")!.getBoundingClientRect();
      const settings = element
        .querySelector('[aria-label="Open Settings"]')!
        .getBoundingClientRect();
      const docs = element
        .querySelector('[aria-label="Open documentation"]')!
        .getBoundingClientRect();
      expect(metrics.right).toBeLessThanOrEqual(docs.left);
      expect(docs.right).toBeLessThanOrEqual(settings.left);
      expect(settings.right).toBeLessThanOrEqual(width);
      expect(element.scrollWidth).toBeLessThanOrEqual(width);
      const result = await axe.run(element.querySelector(".app-bar")!);
      expect(result.violations).toEqual([]);
      await page.screenshot({
        element: element.querySelector(".app-bar")!,
        path: `../test-results/host-metrics-${width}.png`,
      });
      await page.getByRole("button", { name: "Focus terminal", exact: true }).click();
      expect(element.querySelector(".host-metrics")).toBeNull();
      const samplesInFocus = native.invoke.mock.calls.filter(
        ([command]) => command === "sample_header_metrics",
      ).length;
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect(
        native.invoke.mock.calls.filter(([command]) => command === "sample_header_metrics"),
      ).toHaveLength(samplesInFocus);
      await page.getByRole("button", { name: "Exit terminal focus", exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: /: Host metrics for Fixture Alpha$/ }))
        .toBeVisible();
      expect(element.querySelector(".host-metrics")!.textContent).not.toContain("Fixture Alpha");
      if (width === 1440) {
        await page.getByRole("button", { name: "Open Settings" }).click();
        await page.screenshot({ path: "../test-results/host-metrics-settings.png" });
      }
    });
  }
  it("opens documentation in normal and Settings modes and hides it in terminal focus at minimum width", async () => {
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
      let documentationRight = 0;
      if (mode === "focus") {
        await expect.element(docs).not.toBeInTheDocument();
        expect(element.querySelectorAll('[aria-label="Open documentation"]')).toHaveLength(0);
      } else {
        await expect.element(docs).toBeVisible();
        expect(element.querySelectorAll('[aria-label="Open documentation"]')).toHaveLength(1);
        (docs.element() as HTMLButtonElement).focus();
        await userEvent.keyboard("{Enter}");
        await expect
          .poll(
            () =>
              native.invoke.mock.calls.filter(([command]) => command === "open_documentation")
                .length,
          )
          .toBe(mode === "normal" ? 1 : 2);
        await expect.element(docs).toBeEnabled();
        const bounds = docs.element().getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(960);
        documentationRight = bounds.right;
      }
      for (const name of ["Minimize window", "Maximize or restore window", "Close window"]) {
        const control = page.getByRole("button", { name, exact: true });
        await expect.element(control).toBeVisible();
        const controlBounds = control.element().getBoundingClientRect();
        expect(controlBounds.left).toBeGreaterThanOrEqual(documentationRight);
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
  it("keeps Overview focused on host facts without resource polling", async () => {
    currentSettings = { ...currentSettings, hostMetricsEnabled: true };
    await mount();
    await navigate("Overview");
    await expect
      .element(page.getByRole("heading", { name: "Overview", exact: true }))
      .toBeVisible();
    const overview = document.querySelector(".overview-page")!;
    expect(overview.textContent).toContain("Runtime and capabilities");
    for (const label of ["Live load", "Uptime", "Memory"])
      expect(overview.textContent).not.toContain(label);
    expect(
      native.invoke.mock.calls.filter(([command]) => command === "sample_host_resources"),
    ).toHaveLength(0);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await vi.waitFor(() =>
      expect(native.invoke.mock.calls.some(([command]) => command === "refresh_capabilities")).toBe(
        true,
      ),
    );
    expect(
      native.invoke.mock.calls.filter(([command]) => command === "sample_host_resources"),
    ).toHaveLength(0);
    expect((await axe.run(overview)).violations).toEqual([]);
    await expect.element(page.getByText("Live", { exact: true })).toBeVisible();
    await page.screenshot({ element: overview, path: "../test-results/overview-without-load.png" });
    await page.screenshot({ path: "../test-results/overview-full.png" });
  });

  it.each([960, 1600])("keeps long inspection lists scrollable at %s px", async (width) => {
    await page.viewport(width, 700);
    const records = Array.from({ length: 100 }, (_, index) => index);
    overrides.set("list_services", () =>
      records.map((index) => ({ ...fixtures.service, id: `example-${index}.service` })),
    );
    overrides.set("list_containers", () =>
      records.map((index) => ({
        ...fixtures.container,
        id: index.toString(16).padStart(64, "0"),
        name: `example-${index}`,
        composeProject: null,
        ports: `0.0.0.0:${8000 + index}->80/tcp`,
      })),
    );
    overrides.set("list_ports", () =>
      records.map((index) => ({
        ...fixtures.socket,
        id: `socket-${index}`,
        port: 8000 + index,
        systemdUnit: null,
      })),
    );
    overrides.set("inspect_connections", () => ({
      groups: records.map((index) => ({
        key: `peer-${index}`,
        protocol: "tcp",
        localPort: 8000 + index,
        processName: "example",
        processId: index + 1,
        systemdUnit: null,
        established: 1,
        remoteAddressCount: 1,
        remotes: [{ address: "203.0.113.1", count: 1 }],
      })),
      totalEstablished: 100,
      truncated: false,
      collectedAt: new Date().toISOString(),
    }));
    captures = records.map((index) =>
      fixtures.baseline(`baseline-${index}`, `Example baseline ${index}`),
    );
    await mount();
    async function checkList() {
      await vi.waitFor(() =>
        expect(
          element.querySelectorAll(".list-panel .dense-row, .list-panel .docker-branch").length,
        ).toBe(100),
      );
      const panel =
        element.querySelector<HTMLElement>(".services-page .dense-list") ??
        element.querySelector<HTMLElement>(".list-panel")!;
      expect(panel.getBoundingClientRect().height).toBeLessThanOrEqual(
        element.querySelector<HTMLElement>(".connection-section-content")!.clientHeight,
      );
      expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
      const rows = panel.querySelectorAll<HTMLElement>(".dense-row, .docker-branch");
      rows[0].focus();
      await userEvent.keyboard("{End}");
      await vi.waitFor(() =>
        expect(panel.scrollTop + panel.clientHeight).toBeGreaterThanOrEqual(panel.scrollHeight - 1),
      );
      const last = rows[rows.length - 1].getBoundingClientRect();
      expect(last.bottom).toBeLessThanOrEqual(panel.getBoundingClientRect().bottom + 1);
      expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    }
    for (const view of ["Systemd", "Docker", "Baselines"]) {
      await navigate(view);
      await checkList();
    }
    await navigate("Ports");
    for (const tab of ["Table", "Connections", "Docker"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await checkList();
    }
  });

  it.each([960, 1600])(
    "scrolls long History, Boot, Logs, and Scratchpad content at %s px",
    async (width) => {
      await page.viewport(width, 700);
      const records = Array.from({ length: 100 }, (_, index) => index);
      overrides.set("get_history", () =>
        records.map((index) => ({
          id: `entry-${index}`,
          connectionId: "host-a",
          sessionId: "old-session",
          command: `printf example-${index}`,
          cwd: "/",
          startedAt: "2026-10-13T00:00:00Z",
          finishedAt: null,
          exitCode: 0,
          shell: "bash",
        })),
      );
      overrides.set("collect_boot_diagnostics", () => {
        const snapshot = fixtures.boot();
        return {
          ...snapshot,
          journal: {
            ...snapshot.journal,
            data: records.slice(0, 30).map((index) => `warning: example-${index}`),
          },
        };
      });
      overrides.set("get_scratchpad_note", () => ({
        id: "example-note",
        scope: "connection",
        ownerId: "host-a",
        text: records.map((index) => `Example note ${index}`).join("\n"),
        createdAt: "",
        updatedAt: "",
      }));
      await mount();
      for (const view of ["History", "Boot"]) {
        await navigate(view);
        await expect
          .element(
            page.getByText(view === "History" ? "printf example-99" : "warning: example-29", {
              exact: true,
            }),
          )
          .toBeInTheDocument();
        const panel = element.querySelector<HTMLElement>(".feature-page")!;
        expect(panel.getBoundingClientRect().height).toBeLessThanOrEqual(
          element.querySelector<HTMLElement>(".connection-section-content")!.clientHeight,
        );
        expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
        panel.scrollTop = panel.scrollHeight;
        expect(panel.scrollTop).toBeGreaterThan(0);
        expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
      }
      await navigate("Scratchpad");
      await vi.waitFor(() =>
        expect(
          element.querySelector<HTMLTextAreaElement>(".scratchpad-editor textarea")?.value,
        ).toContain("Example note 99"),
      );
      const textarea = element.querySelector<HTMLTextAreaElement>(".scratchpad-editor textarea")!;
      expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);
      textarea.focus();
      await userEvent.keyboard("{Control>}{End}{/Control}");
      expect(textarea.scrollTop).toBeGreaterThan(0);
      await navigate("Logs");
      await page.getByRole("button", { name: "Start", exact: true }).click();
      streamOutput!.onmessage(
        new TextEncoder().encode(records.map((index) => `Example log ${index}`).join("\n")).buffer,
      );
      await expect.element(page.getByText(/Example log 99/)).toBeInTheDocument();
      const output = element.querySelector<HTMLElement>("pre.log-output")!;
      expect(output.scrollHeight).toBeGreaterThan(output.clientHeight);
      output.scrollTop = output.scrollHeight;
      expect(output.scrollTop).toBeGreaterThan(0);
      await navigate("Overview");
      await expect
        .element(page.getByRole("heading", { name: "Overview", exact: true }))
        .toBeVisible();
      await navigate("Terminal");
      await expect.element(page.getByRole("button", { name: "Find in terminal" })).toBeVisible();
    },
  );

  it("expands an open Scratchpad when the window grows", async () => {
    persisted.panelSizes = { "content:scratchpad": 720 };
    await mount();
    await navigate("Scratchpad");
    await expect
      .element(page.getByRole("textbox", { name: "Connection note", exact: true }))
      .toBeVisible();
    for (const width of [1180, 1920, 2560, 960]) {
      await page.viewport(width, 900);
      await vi.waitFor(() => {
        const section = element.querySelector<HTMLElement>(".connection-section")!;
        const content = element.querySelector<HTMLElement>(".connection-section-content")!;
        expect(content.clientWidth).toBe(section.clientWidth);
        const editor = element.querySelector<HTMLElement>(".scratchpad-editor")!;
        const heading = element.querySelector<HTMLElement>(".scratchpad-heading")!;
        const pad = element.querySelector<HTMLElement>(".scratchpad-page")!;
        const style = getComputedStyle(pad);
        const available =
          pad.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        expect(editor.clientWidth).toBeCloseTo(available, 0);
        expect(heading.clientWidth).toBeCloseTo(available, 0);
        expect(pad.scrollWidth).toBeLessThanOrEqual(pad.clientWidth);
      });
      if (width === 1920) {
        await page.screenshot({ path: "../test-results/scratchpad-wide.png" });
      }
    }
  });

  it.each([960, 1600])(
    "scrolls Linux service rows while keeping the filters visible at %s px",
    async (width) => {
      await page.viewport(width, 600);
      overrides.set("list_services", () =>
        Array.from({ length: 100 }, (_, index) => ({
          ...fixtures.service,
          id: `example-${index}.service`,
        })),
      );
      await mount();
      await navigate("Systemd");
      await expect
        .element(page.getByRole("button", { name: /example-99.service/ }))
        .toBeInTheDocument();
      const list = element.querySelector<HTMLElement>(".dense-list")!;
      await userEvent.wheel(list, { delta: { y: 700 } });
      await vi.waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
      await expect.element(page.getByPlaceholder("Search units")).toBeVisible();
      list.focus();
      expect(document.activeElement).toBe(list);
      await userEvent.keyboard("{End}");
      await vi.waitFor(() =>
        expect(list.scrollTop + list.clientHeight).toBeGreaterThanOrEqual(list.scrollHeight - 1),
      );
      await userEvent.click(page.getByRole("button", { name: /example-99.service/ }));
      expect(element.querySelector(".detail-panel h2")?.textContent).toBe("example-99.service");
      await expect.element(page.getByRole("button", { name: "View journal" })).toBeVisible();
      expect(
        (await axe.run(element.querySelector<HTMLElement>(".services-page")!)).violations,
      ).toEqual([]);
      await page.screenshot({ path: `../test-results/linux-service-list-${width}.png` });
    },
  );

  it("offers Windows Docker as its own capability even when detection finds no CLI", async () => {
    const capabilities = {
      ...fixtures.capabilities(),
      osId: "windows",
      osName: "Microsoft Windows 10 Pro",
      dockerAvailable: false,
      dockerAccessible: false,
    };
    overrides.set("get_cached_capabilities", () => capabilities);
    overrides.set("discover_remote_shells", () => ({
      platform: "windows",
      shells: [{ id: "powershell", label: "Windows PowerShell" }],
      capabilities,
      windowsTerminalAvailable: false,
      wslError: null,
    }));
    failures.set("list_containers", "Docker is not installed on this host.");
    root.render(<App />);
    await page
      .getByRole("button", { name: /Fixture Alpha/ })
      .first()
      .click();
    await expect.element(page.getByRole("radio", { name: "Windows PowerShell" })).toBeVisible();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect
      .element(
        page
          .getByRole("navigation", { name: "Workspace features" })
          .getByRole("button", { name: "Docker", exact: true }),
      )
      .toBeVisible();
    await navigate("Docker");
    await expect
      .element(page.getByText("Docker is not installed on this host.", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await navigate("Logs");
    await expect
      .element(page.getByText("Docker is not installed on this host.", { exact: true }))
      .toBeVisible();
    expect(native.invoke.mock.calls.some(([command]) => command === "list_services")).toBe(false);
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
