import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { createRef } from "react";
import { Terminal } from "@xterm/xterm";
import type { TerminalPaneHandle } from "./TerminalPane";
import { TerminalPane } from "./TerminalPane";
import { createLocalWorkspace, createRemoteWorkspace } from "../lib/workspace-target";
import { connection } from "../test/app-fixtures";
import type { AppSettings } from "../types";
import "@xterm/xterm/css/xterm.css";
import "../styles.css";

const session = vi.hoisted(() => ({
  output: null as { onmessage: ((message: ArrayBuffer) => void) | null } | null,
  acknowledgeSessionOutput: vi.fn(() => Promise.resolve()),
  writeSession: vi.fn<(id: string, data: Uint8Array) => Promise<void>>(() => Promise.resolve()),
  resizeSession: vi.fn<(id: string, cols: number, rows: number) => Promise<void>>(() =>
    Promise.resolve(),
  ),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((message: ArrayBuffer) => void) | null = null;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("../lib/api", () => ({
  api: {
    startSession: vi.fn(() => Promise.resolve({ sessionId: "browser-ssh" })),
    startLocalSession: vi.fn(
      (_id: string, _cols: number, _rows: number, output: NonNullable<typeof session.output>) => {
        session.output = output;
        return Promise.resolve({ sessionId: "browser-terminal" });
      },
    ),
    acknowledgeSessionOutput: session.acknowledgeSessionOutput,
    resizeSession: session.resizeSession,
    closeSession: vi.fn(() => Promise.resolve()),
    writeSession: session.writeSession,
  },
  errorMessage: (error: unknown) => String(error),
}));

const settings: AppSettings = {
  terminalFontFamily: "Consolas, monospace",
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
  globalHistoryEnabled: false,
  globalSudoEnabled: false,
  automaticUpdateChecks: false,
  hiddenLocalShells: [],
  localTerminalMode: false,
  defaultLocalShellId: null,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
  session.output = null;
  session.acknowledgeSessionOutput.mockClear();
  session.writeSession.mockClear();
  session.resizeSession.mockClear();
  vi.restoreAllMocks();
});

it("tracks agent progress through real xterm parsing on both screens", async () => {
  container = document.createElement("div");
  Object.assign(container.style, { width: "900px", height: "500px" });
  document.body.append(container);
  root = createRoot(container);
  const onProcessing = vi.fn();
  root.render(
    <TerminalPane
      workspace={{
        ...createLocalWorkspace({
          id: "test-shell",
          label: "Test shell",
          kind: "command-prompt",
          elevated: false,
        }),
        state: "connected",
      }}
      settings={settings}
      visible
      active
      onActivate={() => undefined}
      onSession={() => undefined}
      onState={() => undefined}
      onProcessing={onProcessing}
    />,
  );
  await vi.waitFor(() => expect(session.output).not.toBeNull());
  const output = async (text: string) => {
    const acknowledgements = session.acknowledgeSessionOutput.mock.calls.length;
    session.output!.onmessage!(new TextEncoder().encode(text).buffer);
    await vi.waitFor(() =>
      expect(session.acknowledgeSessionOutput.mock.calls.length).toBeGreaterThan(acknowledgements),
    );
  };
  // An unknown agent can report progress without command-name detection.
  // Split a sequence across IPC messages to exercise xterm's parser buffering.
  await output("\x1b]9;4;");
  await output("3\x07\x1b[?1049hWorking");
  expect(onProcessing).toHaveBeenLastCalledWith(true);
  await output("\r\x1b[2KStill working");
  expect(onProcessing).toHaveBeenLastCalledWith(true);
  // A buffer switch alone must not erase a program's explicit progress.
  await output("\x1b[?1049l");
  expect(onProcessing).toHaveBeenLastCalledWith(true);
  await output("\x1b]9;4;4;50\x1b\\Waiting for approval");
  expect(onProcessing).toHaveBeenLastCalledWith(false);
  await output("\x1b]9;4;1;60\x07");
  expect(onProcessing).toHaveBeenLastCalledWith(true);
  await output("\x1b]9;4;0\x07❯ ");
  expect(onProcessing).toHaveBeenLastCalledWith(false);
  await output("\r\x1b[2K❯ idle redraw");
  expect(onProcessing).toHaveBeenLastCalledWith(false);

  // AntiGravity's main-screen UI erases its footer before repainting it.
  // Exercise the fallback through keyboard input and the real xterm buffer.
  await output("\x1b]133;A\x07\x1b[2J\x1b[H$ ");
  container.querySelector<HTMLTextAreaElement>("textarea")!.focus();
  await userEvent.keyboard("agy.bat{Enter}");
  await output("\r\nWelcome\r\n> \r\n? for shortcuts");
  expect(onProcessing).toHaveBeenLastCalledWith(false);
  await output("\x1b[2J\x1b[HWorking\r\n> \r\nesc to cancel");
  expect(onProcessing).toHaveBeenLastCalledWith(true);
  await output("\x1b[2J\x1b[HStreaming reply\r\n> ");
  expect(onProcessing).toHaveBeenLastCalledWith(true);
  await output("\r\nesc to cancel");
  expect(onProcessing).toHaveBeenLastCalledWith(true);
  await output("\x1b[2J\x1b[HDone\r\n> \r\n? for shortcuts");
  expect(onProcessing).toHaveBeenLastCalledWith(false);
});

it("refits terminal columns and rows and resizes the same session when its pane changes", async () => {
  await page.viewport(1280, 800);
  container = document.createElement("div");
  Object.assign(container.style, { position: "relative", width: "800px", height: "500px" });
  document.body.append(container);
  root = createRoot(container);
  root.render(
    <TerminalPane
      workspace={createLocalWorkspace({
        id: "test-shell",
        label: "Test shell",
        kind: "command-prompt",
        elevated: false,
      })}
      settings={settings}
      visible
      active
      onActivate={() => undefined}
      onSession={() => undefined}
      onState={() => undefined}
    />,
  );
  await vi.waitFor(() => expect(session.resizeSession).toHaveBeenCalled());
  const initial = session.resizeSession.mock.calls.at(-1)!;
  container.style.width = "450px";
  container.style.height = "250px";
  await vi.waitFor(() => {
    const resized = session.resizeSession.mock.calls.at(-1)!;
    expect(resized[0]).toBe(initial[0]);
    expect(resized[1]).toBeLessThan(initial[1]);
    expect(resized[2]).toBeLessThan(initial[2]);
    expect(resized[1]).toBeGreaterThan(0);
    expect(resized[2]).toBeGreaterThan(0);
  });
  session.output!.onmessage!(new TextEncoder().encode("RESIZED_SESSION_OK\r\n").buffer);
  await expect.element(page.getByText("RESIZED_SESSION_OK", { exact: true })).toBeVisible();
});

function paintedPixels(canvas: HTMLCanvasElement) {
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 0) count += 1;
  }
  return count;
}

it("pastes Unicode and multiple lines once and copies the actual terminal selection", async () => {
  const text = "日本語-é\nsecond line";
  const read = vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(text);
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  container = document.createElement("div");
  container.style.height = "400px";
  document.body.append(container);
  root = createRoot(container);
  const handle = createRef<TerminalPaneHandle>();
  root.render(
    <TerminalPane
      ref={handle}
      workspace={createLocalWorkspace({
        id: "test-shell",
        label: "Test shell",
        kind: "command-prompt",
        elevated: false,
      })}
      settings={settings}
      visible
      active
      onActivate={() => undefined}
      onSession={() => undefined}
      onState={() => undefined}
    />,
  );
  await vi.waitFor(() => expect(session.output).not.toBeNull());
  handle.current!.pasteClipboard();
  await vi.waitFor(() => expect(session.writeSession).toHaveBeenCalledTimes(1));
  expect(read).toHaveBeenCalledTimes(1);
  expect(new TextDecoder().decode(session.writeSession.mock.calls[0][1])).toBe(
    text.replaceAll("\n", "\r"),
  );
  session.output!.onmessage!(new TextEncoder().encode("COPY_NEEDLE\r\n").buffer);
  await expect.element(page.getByText("COPY_NEEDLE", { exact: true })).toBeVisible();
  await userEvent.dblClick(container.querySelector(".xterm-screen")!, {
    position: { x: 15, y: 5 },
  });
  handle.current!.copySelection();
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith("COPY_NEEDLE"));
});

it("keeps the terminal edge empty until search has matches", async () => {
  await page.viewport(960, 640);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const workspace = createLocalWorkspace({
    id: "test-shell",
    label: "Test shell",
    kind: "git-bash",
    elevated: false,
  });
  const renderPane = (findRequest: number) =>
    root!.render(
      <TerminalPane
        workspace={workspace}
        settings={settings}
        visible
        active
        findRequest={findRequest}
        onActivate={() => undefined}
        onSession={() => undefined}
        onState={() => undefined}
      />,
    );
  renderPane(0);
  await vi.waitFor(() => expect(session.output).not.toBeNull());
  session.output!.onmessage!(new TextEncoder().encode("test-shell$ ").buffer);
  await vi.waitFor(() => expect(session.acknowledgeSessionOutput).toHaveBeenCalled());
  const ruler = container.querySelector<HTMLCanvasElement>(".xterm-decoration-overview-ruler")!;
  await vi.waitFor(() => {
    expect(ruler.height).toBeGreaterThan(0);
    expect(paintedPixels(ruler)).toBe(0);
  });

  const output = Array.from(
    { length: 80 },
    (_, index) => `\r\n${index % 30 === 0 ? "needle" : "output"} ${index}`,
  ).join("");
  session.output!.onmessage!(new TextEncoder().encode(output).buffer);
  renderPane(1);
  await page.getByRole("textbox", { name: "Find in terminal output" }).fill("needle");
  await expect.element(page.getByText(/of 3/)).toBeVisible();
  await vi.waitFor(() => expect(paintedPixels(ruler)).toBeGreaterThan(0));
  await page.getByRole("button", { name: "Close terminal search" }).click();
  await vi.waitFor(() => expect(paintedPixels(ruler)).toBe(0));
});

it("keeps every terminal on the saved palette through search and tab changes", async () => {
  const terminals: Terminal[] = [];
  const open = Terminal.prototype.open;
  vi.spyOn(Terminal.prototype, "open").mockImplementation(function (this: Terminal, parent) {
    terminals.push(this);
    open.call(this, parent);
  });
  container = document.createElement("div");
  Object.assign(container.style, { position: "relative", width: "800px", height: "400px" });
  document.body.append(container);
  root = createRoot(container);
  const workspaces = [
    createRemoteWorkspace(connection()),
    createLocalWorkspace({ id: "git-bash", label: "Git Bash", kind: "git-bash", elevated: false }),
    createLocalWorkspace({
      id: "cmd",
      label: "Command Prompt",
      kind: "command-prompt",
      elevated: false,
    }),
    createLocalWorkspace({
      id: "pwsh",
      label: "PowerShell",
      kind: "powershell-7",
      elevated: false,
    }),
  ];
  const render = (palette: AppSettings, selected = 0, findRequest = 0) =>
    root!.render(
      <>
        {workspaces.map((workspace, index) => (
          <TerminalPane
            key={workspace.id}
            workspace={workspace}
            settings={palette}
            visible={index === selected}
            active={index === selected}
            findRequest={index === selected ? findRequest : 0}
            onActivate={() => undefined}
            onSession={() => undefined}
            onState={() => undefined}
          />
        ))}
      </>,
    );
  const expectPalette = (palette: AppSettings) => {
    for (const terminal of terminals)
      expect(terminal.options.theme).toMatchObject({
        foreground: palette.terminalForeground,
        green: palette.terminalGreen,
        blue: palette.terminalBlue,
      });
  };
  render(settings);
  await vi.waitFor(() => expect(terminals).toHaveLength(4));
  const saved = {
    ...settings,
    terminalForeground: "#eeeeee",
    terminalGreen: "#22aa44",
    terminalBlue: "#8866cc",
  };
  render(saved);
  await vi.waitFor(() => expectPalette(saved));
  render(saved, 0, 1);
  await page.getByRole("textbox", { name: "Find in terminal output" }).fill("needle");
  await vi.waitFor(() =>
    expect(terminals[0].options.theme?.selectionBackground).toBe("transparent"),
  );
  expectPalette(saved);
  const updated = { ...saved, terminalGreen: "#55cc77" };
  render(updated, 0, 1);
  await vi.waitFor(() => expectPalette(updated));
  expect(terminals[0].options.theme?.selectionBackground).toBe("transparent");
  await page.getByRole("button", { name: "Close terminal search" }).click();
  await vi.waitFor(() => expect(terminals[0].options.theme?.selectionBackground).toBe("#393939"));
  expectPalette(updated);
  render(updated, 1, 1);
  await page.getByRole("textbox", { name: "Find in terminal output" }).fill("needle");
  await vi.waitFor(() =>
    expect(terminals[1].options.theme?.selectionBackground).toBe("transparent"),
  );
  expectPalette(updated);
  expect(terminals).toHaveLength(4);
});
