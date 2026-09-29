import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { TerminalPane } from "./TerminalPane";
import { createLocalWorkspace } from "../lib/workspace-target";
import type { AppSettings } from "../types";
import "@xterm/xterm/css/xterm.css";
import "../styles.css";

const session = vi.hoisted(() => ({
  output: null as { onmessage: ((message: ArrayBuffer) => void) | null } | null,
  acknowledgeSessionOutput: vi.fn(() => Promise.resolve()),
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
    startLocalSession: vi.fn(
      (_id: string, _cols: number, _rows: number, output: NonNullable<typeof session.output>) => {
        session.output = output;
        return Promise.resolve({ sessionId: "browser-terminal" });
      },
    ),
    acknowledgeSessionOutput: session.acknowledgeSessionOutput,
    resizeSession: vi.fn(() => Promise.resolve()),
    closeSession: vi.fn(() => Promise.resolve()),
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
});

function paintedPixels(canvas: HTMLCanvasElement) {
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 0) count += 1;
  }
  return count;
}

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
