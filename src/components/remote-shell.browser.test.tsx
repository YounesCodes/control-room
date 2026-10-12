import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { RemoteShellDialog } from "./RemoteShellDialog";
import type { SavedConnection } from "../types";
import "../styles.css";

vi.mock("../lib/api", () => ({
  api: {
    discoverRemoteShells: vi.fn(() =>
      Promise.resolve({
        platform: "windows",
        shells: [
          { id: "powershell", label: "Windows PowerShell" },
          { id: "wsl:Ubuntu", label: "WSL: Ubuntu" },
        ],
        windowsTerminalAvailable: true,
        wslError: null,
      }),
    ),
  },
  errorMessage: String,
}));
let root: Root;
let host: HTMLDivElement;
afterEach(() => {
  root?.unmount();
  host?.remove();
});
describe("Windows remote shell picker", () => {
  it("supports keyboard shell selection and an accessible bounded dialog", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const onSelect = vi.fn();
    root.render(
      <RemoteShellDialog
        connection={{ id: "windows-test", displayName: "Windows test host" } as SavedConnection}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    const select = page.getByRole("combobox", { name: "Remote shell" });
    await expect.element(select).toBeVisible();
    await userEvent.selectOptions(select, "wsl:Ubuntu");
    await userEvent.click(page.getByRole("button", { name: "Connect", exact: true }));
    expect(onSelect).toHaveBeenCalledWith({ id: "wsl:Ubuntu", label: "WSL: Ubuntu" });
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(530);
    const accessibility = await axe.run(host, { rules: { region: { enabled: false } } });
    expect(accessibility.violations).toEqual([]);
  });
});
