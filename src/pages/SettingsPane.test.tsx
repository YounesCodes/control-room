// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  saveSettings: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { SettingsPane } from "./SettingsPane";
import type { AppSettings, EnvironmentInfo } from "../types";

const settings: AppSettings = {
  terminalFontFamily: "Cascadia Mono, Consolas, monospace",
  terminalFontSize: 14,
  terminalScrollback: 10_000,
  terminalRightClickPaste: false,
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
};

const environment: EnvironmentInfo = {
  sshPath: "C:/Windows/System32/OpenSSH/ssh.exe",
  sshConfigPath: "C:/Users/test/.ssh/config",
  sshAgentAvailable: true,
  platformSupported: true,
};

function renderPane(overrides: Partial<Parameters<typeof SettingsPane>[0]> = {}) {
  const props = {
    settings,
    defaults: settings,
    logTailOptions: [50, 100, 200, 500, 1000],
    environment,
    onSaved: vi.fn(),
    onClose: vi.fn(() => true),
    onDirtyChange: vi.fn(),
    ...overrides,
  };
  render(<SettingsPane {...props} />);
  return props;
}

const saveButton = () => screen.getByRole("button", { name: /Save settings/ }) as HTMLButtonElement;

describe("Settings actions", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    api.saveSettings.mockResolvedValue(undefined);
  });

  it("keeps Back and Save reachable without scrolling to the end of the form", () => {
    renderPane();

    // Both live in the header, above the scrolling region, so neither depends
    // on how far down the form the reader has gone.
    const header = screen.getByRole("banner");
    expect(header.contains(screen.getByRole("button", { name: "Back to terminal" }))).toBe(true);
    expect(header.contains(saveButton())).toBe(true);
  });

  it("offers Save only once something has actually changed", async () => {
    const user = userEvent.setup();
    renderPane();

    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    await user.clear(screen.getByLabelText(/Font size/i));
    await user.type(screen.getByLabelText(/Font size/i), "16");

    expect(saveButton().disabled).toBe(false);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("reports the save next to the button and drops it on the next edit", async () => {
    const user = userEvent.setup();
    const props = renderPane();

    const fontSize = screen.getByLabelText(/Font size/i);
    await user.clear(fontSize);
    await user.type(fontSize, "16");
    await user.click(saveButton());

    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ terminalFontSize: 16 }),
    );
    expect(props.onSaved).toHaveBeenCalled();
    expect(await screen.findByText("Settings saved.")).toBeTruthy();

    // The result described the draft that was saved, so editing again retires it
    // rather than leaving a stale "saved" beside a form that has since moved on.
    await user.type(fontSize, "0");
    expect(screen.queryByText("Settings saved.")).toBeNull();
  });

  it("surfaces a failed save without claiming it worked", async () => {
    const user = userEvent.setup();
    api.saveSettings.mockRejectedValue(new Error("Settings file is read only"));
    const props = renderPane();

    const fontSize = screen.getByLabelText(/Font size/i);
    await user.clear(fontSize);
    await user.type(fontSize, "16");
    await user.click(saveButton());

    expect(await screen.findByText("Settings file is read only")).toBeTruthy();
    expect(props.onSaved).not.toHaveBeenCalled();
    // Still dirty, so the reader can correct the problem and try again.
    expect(saveButton().disabled).toBe(false);
  });
});
