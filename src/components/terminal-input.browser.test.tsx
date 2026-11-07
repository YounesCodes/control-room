import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { createRef } from "react";
import { Terminal } from "@xterm/xterm";
import type { TerminalPaneHandle } from "./TerminalPane";
import { TerminalPane } from "./TerminalPane";
import { createLocalWorkspace } from "../lib/workspace-target";
import type { AppSettings } from "../types";
import "@xterm/xterm/css/xterm.css";
import "../styles.css";

// Regression coverage for issue #200: selecting and pasting in a terminal
// where the program in the pty reads the mouse and redraws constantly, the
// way coding-agent TUIs do. Every test drives a real xterm host in real
// Chromium, the same engine WebView2 embeds, so selection state, keyboard
// input, and paste events travel the routes they do in the app.

const session = vi.hoisted(() => ({
  output: null as { onmessage: ((message: ArrayBuffer) => void) | null } | null,
  acknowledgeSessionOutput: vi.fn(() => Promise.resolve()),
  writeSession: vi.fn<(id: string, data: Uint8Array) => Promise<void>>(() => Promise.resolve()),
  resizeSession: vi.fn<(id: string, cols: number, rows: number) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  stagePasteImage: vi.fn<
    (connectionId: string | null, data: Uint8Array, extension: string) => Promise<string>
  >(() => Promise.resolve("")),
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
    startSession: vi.fn(),
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
    stagePasteImage: session.stagePasteImage,
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
const terminals: Terminal[] = [];

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
  session.output = null;
  session.acknowledgeSessionOutput.mockClear();
  session.writeSession.mockClear();
  session.resizeSession.mockClear();
  session.stagePasteImage.mockReset();
  vi.restoreAllMocks();
});

// Everything a mouse-driven TUI asks the terminal for: an alternate screen,
// cell and motion mouse reporting, bracketed paste, and focus reports.
const AGENT_MODES =
  "\u001b[?1049h\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1015h\u001b[?1006h\u001b[?2004h\u001b[?1004h";
const AGENT_SCREEN =
  AGENT_MODES + "\u001b[2J\u001b[1;1Hfirst line alpha\r\nsecond line beta\r\nthird line gamma";

function ptyToXterm(text: string) {
  expect(session.output).not.toBeNull();
  session.output!.onmessage!(new TextEncoder().encode(text).buffer);
}

function written() {
  return session.writeSession.mock.calls.map(([, bytes]) => new TextDecoder().decode(bytes));
}

function writtenText() {
  return written().join("");
}

async function mountPane(onSelectionChange: (has: boolean) => void = () => undefined) {
  const open = Terminal.prototype.open;
  vi.spyOn(Terminal.prototype, "open").mockImplementation(function (this: Terminal, parent) {
    if (!terminals.includes(this)) terminals.push(this);
    return open.call(this, parent);
  });
  container = document.createElement("div");
  Object.assign(container.style, { position: "relative", width: "800px", height: "400px" });
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
      onSelectionChange={onSelectionChange}
    />,
  );
  await vi.waitFor(() => expect(session.output).not.toBeNull());
  const terminal = terminals.at(-1)!;
  return { handle, terminal };
}

function screen() {
  const element = document.querySelector(".xterm-screen") as HTMLElement;
  expect(element).not.toBeNull();
  return element;
}

function screenRect() {
  return screen().getBoundingClientRect();
}

// The pixel row of the terminal's first text line, at the pane's font metrics.
const FIRST_LINE_Y = Math.floor(14 * 1.2);

function dispatchSelectionGesture(type: string, x: number, detail: number, shiftKey = true) {
  const rect = screenRect();
  screen().dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      shiftKey,
      clientX: rect.left + x,
      clientY: rect.top + FIRST_LINE_Y,
      button: 0,
      detail,
    }),
  );
}

async function renderAgentScreen() {
  ptyToXterm(AGENT_SCREEN);
  await vi.waitFor(() => expect(session.acknowledgeSessionOutput).toHaveBeenCalled());
}

it("a Shift+drag over a mouse-reporting program selects text and reports it for copying", async () => {
  // The Copy button listens to selections; a TUI that grabbed the mouse must
  // not make selecting impossible.
  const selectionEvents: boolean[] = [];
  const { handle, terminal } = await mountPane((has) => selectionEvents.push(has));
  await renderAgentScreen();
  session.writeSession.mockClear();

  dispatchSelectionGesture("mousedown", 5, 1);
  dispatchSelectionGesture("mousemove", 90, 1);
  dispatchSelectionGesture("mousemove", 160, 1);
  dispatchSelectionGesture("mouseup", 160, 1);

  expect(terminal.getSelection()).toBe("first line alpha");
  expect(selectionEvents.at(-1)).toBe(true);
  // The gesture belonged to Control Room, so the program received nothing.
  expect(written()).toEqual([]);

  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  handle.current!.copySelection();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  expect(writeText.mock.calls[0][0]).toBe("first line alpha");
});

it("an ordinary drag while a program reports the mouse forwards the mouse and selects nothing", async () => {
  const selectionEvents: boolean[] = [];
  const { terminal } = await mountPane((has) => selectionEvents.push(has));
  await renderAgentScreen();
  session.writeSession.mockClear();

  await userEvent.pointer([
    { target: screen(), coords: { x: 5, y: FIRST_LINE_Y } },
    { keys: "[MouseLeft>]", target: screen(), coords: { x: 5, y: FIRST_LINE_Y } },
    { target: screen(), coords: { x: 160, y: FIRST_LINE_Y } },
    { keys: "[/MouseLeft]", target: screen(), coords: { x: 160, y: FIRST_LINE_Y } },
  ]);

  expect(terminal.hasSelection()).toBe(false);
  // No event ever reports a selection, so the Copy button stays disabled.
  expect(selectionEvents.every((event) => event === false)).toBe(true);
  // The program owns the gesture: it received the mouse reports it asked for.
  expect(writtenText()).toContain("\u001b[<");
});

it("a Shift double-click over reporting mouse selects the word under it", async () => {
  const { terminal } = await mountPane();
  await renderAgentScreen();

  // Column ~100 lands inside "alpha" of the first line.
  dispatchSelectionGesture("mousedown", 100, 2);
  dispatchSelectionGesture("mouseup", 100, 2);

  expect(terminal.getSelection()).toBe("alpha");
});

it("Escape cancels a Shift+drag while it is in progress", async () => {
  const selectionEvents: boolean[] = [];
  const { terminal } = await mountPane((has) => selectionEvents.push(has));
  await renderAgentScreen();
  session.writeSession.mockClear();

  dispatchSelectionGesture("mousedown", 5, 1);
  dispatchSelectionGesture("mousemove", 90, 1);
  expect(terminal.hasSelection()).toBe(true);
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  dispatchSelectionGesture("mouseup", 90, 1);

  expect(terminal.hasSelection()).toBe(false);
  expect(selectionEvents).toContain(false);
  // The key never reached the program either.
  expect(written()).toEqual([]);
});

it("a selection survives program redraws and focus changes", async () => {
  const selectionEvents: boolean[] = [];
  const { terminal } = await mountPane((has) => selectionEvents.push(has));
  await renderAgentScreen();

  dispatchSelectionGesture("mousedown", 5, 1);
  dispatchSelectionGesture("mousemove", 160, 1);
  dispatchSelectionGesture("mouseup", 160, 1);
  expect(terminal.getSelection()).toBe("first line alpha");

  // The TUI redraws a spinner on another row while the text is selected.
  session.acknowledgeSessionOutput.mockClear();
  ptyToXterm("\u001b[3;1H\u001b[2Kspinner frame one \u001b[3;1H\u001b[2Kspinner frame two ");
  await vi.waitFor(() => expect(session.acknowledgeSessionOutput).toHaveBeenCalled());

  terminal.blur();
  await vi.waitFor(() => expect(document.activeElement).not.toBe(terminal.textarea));

  expect(terminal.hasSelection()).toBe(true);
  expect(terminal.getSelection()).toBe("first line alpha");
  // Once reported, the selection was never reported gone.
  const selectedAt = selectionEvents.indexOf(true);
  expect(selectedAt).toBeGreaterThan(-1);
  expect(selectionEvents.slice(selectedAt).every((event) => event)).toBe(true);
});

it("pasting and pressing Enter sends the paste exactly once", async () => {
  const { handle } = await mountPane();
  await renderAgentScreen();
  const pasted = "fix the login bug\nadd regression tests";
  vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(pasted);
  session.writeSession.mockClear();

  handle.current!.pasteClipboard();
  await vi.waitFor(() => expect(writtenText()).toContain("fix the login bug"));
  // One paste, multiline content intact, wrapped in bracketed-paste markers.
  expect(writtenText()).toContain("\u001b[200~fix the login bug\radd regression tests\u001b[201~");

  await userEvent.click(screen());
  await userEvent.keyboard("{Enter}");

  // Enter submits the prompt; the pasted text never rides along a second time.
  const text = writtenText();
  expect(text.split("fix the login bug").length - 1).toBe(1);
  expect(written().at(-1)).toBe("\r");
});

it("a clipboard image pastes as the staged path its CLI can open", async () => {
  const { handle } = await mountPane();
  await renderAgentScreen();
  vi.spyOn(navigator.clipboard, "readText").mockResolvedValue("");
  const image = {
    types: ["image/png"],
    getType: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
  };
  vi.spyOn(navigator.clipboard, "read").mockResolvedValue([image as unknown as ClipboardItem]);
  session.stagePasteImage.mockResolvedValue("/tmp/control-room-paste/paste-1.png");
  session.writeSession.mockClear();

  handle.current!.pasteClipboard();
  await vi.waitFor(() => expect(writtenText()).toContain("/tmp/control-room-paste/paste-1.png"));

  expect(session.stagePasteImage).toHaveBeenCalledTimes(1);
  const [, bytes, extension] = session.stagePasteImage.mock.calls[0];
  expect(Array.from(bytes as Uint8Array)).toEqual([1, 2, 3]);
  expect(extension).toBe("png");
  expect(writtenText().split("/tmp/control-room-paste/paste-1.png").length - 1).toBe(1);
});

it("hovering over a motion-reporting program keeps a finished selection alive", async () => {
  const selectionEvents: boolean[] = [];
  const { terminal } = await mountPane((has) => selectionEvents.push(has));
  await renderAgentScreen();
  session.writeSession.mockClear();

  dispatchSelectionGesture("mousedown", 5, 1);
  dispatchSelectionGesture("mousemove", 90, 1);
  dispatchSelectionGesture("mousemove", 160, 1);
  dispatchSelectionGesture("mouseup", 160, 1);
  expect(terminal.getSelection()).toBe("first line alpha");

  // Pointer motion with no buttons held reports to a program that asked for
  // any-motion tracking, and every report is input that clears selections. The
  // pane keeps hover moves for itself while the selection lives.
  const rect = screenRect();
  for (const x of [20, 90, 160]) {
    screen().dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + x,
        clientY: rect.top + FIRST_LINE_Y,
        buttons: 0,
      }),
    );
  }
  expect(terminal.hasSelection()).toBe(true);
  // The program received none of those hovers.
  expect(written()).toEqual([]);

  // Right-clicking the live selection copies it: clipboard write, no click.
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const right = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: rect.left + 100,
    clientY: rect.top + FIRST_LINE_Y,
  });
  screen().dispatchEvent(right);
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  expect(writeText.mock.calls[0][0]).toBe("first line alpha");
  expect(terminal.hasSelection()).toBe(true);
});

it("a native paste event sends its clipboard text exactly once", async () => {
  await mountPane();
  await renderAgentScreen();
  await userEvent.click(screen());
  session.writeSession.mockClear();

  const data = new DataTransfer();
  data.setData("text/plain", "native paste body\nsecond row");
  screen()
    .querySelector(".xterm-helper-textarea")
    ?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );

  await vi.waitFor(() => expect(writtenText()).toContain("native paste body"));
  const text = writtenText();
  expect(text).toContain("\u001b[200~native paste body\rsecond row\u001b[201~");
  expect(text.split("native paste body").length - 1).toBe(1);
});
