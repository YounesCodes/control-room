import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { RemoteShellDialog } from "./RemoteShellDialog";
import { HostOsIcon } from "./HostOsIcon";
import type { SavedConnection } from "../types";
import "../styles.css";

vi.mock("../lib/api", () => ({
  api: {
    discoverRemoteShells: vi.fn(() =>
      Promise.resolve({
        platform: "windows",
        shells: [
          { id: "powershell", label: "Windows PowerShell" },
          { id: "cmd", label: "Command Prompt" },
          { id: "wsl:Ubuntu", label: "WSL: Ubuntu" },
        ],
        windowsTerminalAvailable: true,
        wslError: null,
        capabilities: { osId: "windows", osName: "Microsoft Windows 10 Pro" },
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
    const select = page.getByRole("radio", { name: "WSL: Ubuntu" });
    await expect.element(select).toBeVisible();
    const row = host
      .querySelector<HTMLInputElement>('input[value="wsl:Ubuntu"]')!
      .closest("label")!;
    const selectedRow = host.querySelector(".remote-shell-option.selected")!;
    const selectedBorder = getComputedStyle(selectedRow).borderColor;
    const selectedFill = getComputedStyle(selectedRow).backgroundColor;
    await userEvent.hover(page.getByRole("radio", { name: "Windows PowerShell" }));
    expect(getComputedStyle(selectedRow).borderColor).toBe(selectedBorder);
    expect(getComputedStyle(selectedRow).backgroundColor).toBe(selectedFill);
    await userEvent.hover(select);
    expect(getComputedStyle(row).borderColor).not.toBe(getComputedStyle(selectedRow).borderColor);
    await page
      .getByRole("dialog")
      .screenshot({ path: "../../test-results/windows-shell-hover.png" });
    const radio = row.querySelector("input")!;
    await userEvent.click(select);
    expect(getComputedStyle(row).outlineStyle).toBe("none");
    expect(getComputedStyle(radio).boxShadow).toBe("none");
    await userEvent.tab();
    await userEvent.tab({ shift: true });
    expect(radio.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(row).outlineStyle).toBe("solid");
    expect(Number.parseFloat(getComputedStyle(row).outlineOffset)).toBeLessThanOrEqual(0);
    await userEvent.click(select);
    await userEvent.click(page.getByRole("button", { name: "Connect", exact: true }));
    expect(onSelect).toHaveBeenCalledWith({ id: "wsl:Ubuntu", label: "WSL: Ubuntu" });
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(530);
    const accessibility = await axe.run(host, { rules: { region: { enabled: false } } });
    expect(accessibility.violations).toEqual([]);
    await page
      .getByRole("dialog")
      .screenshot({ path: "../../test-results/windows-shell-picker.png" });
  });
  it("renders gray Windows marks and the detected version", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    root.render(
      <>
        <HostOsIcon osId="windows" osName="Microsoft Windows 10 Pro" />
        <HostOsIcon osId="windows" osName="Microsoft Windows 11 Pro" />
      </>,
    );
    await expect.element(page.getByRole("img", { name: "Windows 10 host" })).toBeVisible();
    await expect.element(page.getByRole("img", { name: "Windows 11 host" })).toBeVisible();
    const icon = host.querySelector(".host-os-windows")!;
    expect(getComputedStyle(icon.querySelector("path")!).fill).toBe(getComputedStyle(icon).color);
    expect(getComputedStyle(icon.querySelector("path")!).fill).not.toBe("rgb(0, 0, 0)");
    expect(icon.querySelector(".host-os-version")?.textContent).toBe("10");
    expect(
      Number.parseFloat(getComputedStyle(icon.querySelector(".host-os-version")!).fontSize),
    ).toBeGreaterThanOrEqual(10);
  });
});
