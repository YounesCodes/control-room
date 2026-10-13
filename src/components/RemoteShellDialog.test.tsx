// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedConnection } from "../types";

const discoverRemoteShells = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ api: { discoverRemoteShells }, errorMessage: String }));
import { RemoteShellDialog } from "./RemoteShellDialog";

const connection = { id: "host-id", displayName: "Windows test host" } as SavedConnection;
const shells = [
  { id: "powershell", label: "Windows PowerShell" },
  { id: "wsl:Ubuntu", label: "WSL: Ubuntu" },
];
beforeEach(() => {
  discoverRemoteShells.mockReset().mockResolvedValue({
    platform: "windows",
    shells,
    windowsTerminalAvailable: true,
    wslError: null,
  });
});
afterEach(cleanup);

describe("remote shell selection", () => {
  it("waits for a deliberate choice and sends the selected WSL profile", async () => {
    const onSelect = vi.fn();
    render(<RemoteShellDialog connection={connection} onClose={vi.fn()} onSelect={onSelect} />);
    await screen.findByRole("radio", { name: "Windows PowerShell" });
    expect(onSelect).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: "WSL: Ubuntu" }));
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onSelect).toHaveBeenCalledWith(shells[1]);
    expect(screen.getByRole("group", { name: "WSL distributions" })).toBeTruthy();
  });
  it("opens Linux without offering Windows shells", async () => {
    discoverRemoteShells.mockResolvedValue({ platform: "linux", shells: [] });
    const onSelect = vi.fn();
    render(<RemoteShellDialog connection={connection} onClose={vi.fn()} onSelect={onSelect} />);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
    expect(screen.queryByRole("combobox")).toBeNull();
  });
  it("refreshes discovery while retaining a shell that is still available", async () => {
    render(<RemoteShellDialog connection={connection} onClose={vi.fn()} onSelect={vi.fn()} />);
    await userEvent.click(await screen.findByRole("radio", { name: "WSL: Ubuntu" }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh available shells" }));
    await waitFor(() => expect(discoverRemoteShells).toHaveBeenLastCalledWith(connection.id, true));
    await waitFor(() =>
      expect((screen.getByRole("radio", { name: "WSL: Ubuntu" }) as HTMLInputElement).checked).toBe(
        true,
      ),
    );
  });
  it("shows detection failure and retries without starting a session", async () => {
    discoverRemoteShells.mockRejectedValueOnce("SSH authentication failed");
    const onSelect = vi.fn();
    render(<RemoteShellDialog connection={connection} onClose={vi.fn()} onSelect={onSelect} />);
    await screen.findByRole("alert");
    expect(onSelect).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("radio", { name: "Windows PowerShell" });
    expect(discoverRemoteShells).toHaveBeenCalledTimes(2);
  });
  it("ignores discovery after cancellation and restores keyboard focus", async () => {
    let finish!: (result: unknown) => void;
    discoverRemoteShells.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const rendered = render(
      <RemoteShellDialog connection={connection} onClose={onClose} onSelect={onSelect} />,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    rendered.unmount();
    finish({ platform: "linux", shells: [] });
    await Promise.resolve();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
