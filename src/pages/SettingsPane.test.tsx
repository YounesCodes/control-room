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
    appVersion: "0.6.1",
    onCheckForUpdates: vi.fn(async () => ({ outcome: "current" }) as const),
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

  it("shows the running version and the update preference", () => {
    renderPane();
    expect(screen.getByText("v0.6.1")).toBeTruthy();
    const preference = screen.getByLabelText("Automatically check for updates") as HTMLInputElement;
    expect(preference.checked).toBe(true);
  });

  it("checks manually even with automatic checks turned off", async () => {
    const user = userEvent.setup();
    const onCheckForUpdates = vi.fn(async () => ({ outcome: "current" }) as const);
    renderPane({
      settings: { ...settings, automaticUpdateChecks: false },
      defaults: { ...settings, automaticUpdateChecks: false },
      onCheckForUpdates,
    });

    const preference = screen.getByLabelText("Automatically check for updates") as HTMLInputElement;
    expect(preference.checked).toBe(false);

    // Turning the schedule off is not the same as refusing to look.
    await user.click(screen.getByRole("button", { name: /Check for updates/ }));
    expect(onCheckForUpdates).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("You're up to date.")).toBeTruthy();
  });

  it("names the available version after a manual check", async () => {
    const user = userEvent.setup();
    renderPane({
      onCheckForUpdates: vi.fn(async () => ({ outcome: "available", version: "0.7.0" }) as const),
    });
    await user.click(screen.getByRole("button", { name: /Check for updates/ }));
    expect(await screen.findByText("Version 0.7.0 is available.")).toBeTruthy();
  });

  it("reports a failed manual check concisely, with the reason beneath it", async () => {
    const user = userEvent.setup();
    renderPane({
      onCheckForUpdates: vi.fn(
        async () =>
          ({
            outcome: "failed",
            failure: { kind: "check", message: "Could not reach the update endpoint." },
          }) as const,
      ),
    });
    await user.click(screen.getByRole("button", { name: /Check for updates/ }));
    expect(await screen.findByText(/Could not check for updates\./)).toBeTruthy();
    expect(screen.getByText("Could not reach the update endpoint.")).toBeTruthy();
  });

  it("keeps app updates verbally distinct from Remote Host packages", () => {
    renderPane();
    // AGENTS.md rules out remote package management entirely, so this section
    // must not read as if it could update anything on a Linux host.
    expect(screen.getByText("Control Room updates")).toBeTruthy();
    expect(screen.queryByText(/Remote Host packages/i)).toBeNull();
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
