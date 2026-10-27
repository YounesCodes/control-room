import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { HostOsIcon } from "./HostOsIcon";
import { LocalShellIcon } from "./LocalShellIcon";
import "../styles.css";

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  root?.unmount();
  container?.remove();
});

it("uses the same logo scale for every OS and local shell, including larger dialog marks", async () => {
  await page.viewport(1040, 800);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const operatingSystems = [
    "debian",
    "ubuntu",
    "windows",
    "fedora",
    "arch",
    "opensuse",
    "alpine",
    "linuxmint",
    "kali",
    "rhel",
    "centos",
    "rocky",
    "almalinux",
    "nixos",
    "manjaro",
    "suse",
    "ol",
    "amzn",
    "unknown",
  ];
  const shells = ["git-bash", "powershell-7", "windows-powershell", "command-prompt"] as const;
  const entries = [
    ...operatingSystems.map((osId) => ({ label: osId, icon: <HostOsIcon osId={osId} /> })),
    ...shells.map((kind) => ({ label: kind, icon: <LocalShellIcon kind={kind} /> })),
    { label: "Administrator", icon: <LocalShellIcon kind="powershell-7" elevated /> },
    { label: "Windows 11", icon: <HostOsIcon osId="windows" osName="Windows 11 Pro" /> },
  ];
  root.render(
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, padding: 24 }}>
      {entries.map(({ label, icon }) => (
        <div className="session-tab-wrap" key={label}>
          <button className="session-tab-main" type="button" style={{ width: "100%" }}>
            {icon}
            <span>{label}</span>
          </button>
        </div>
      ))}
      <div className="remote-shell-host" data-heading-mark>
        <HostOsIcon osId="windows" />
      </div>
    </div>,
  );
  await expect.element(page.getByRole("button", { name: "Administrator" })).toBeVisible();
  for (const row of container.querySelectorAll(".session-tab-wrap")) {
    const mark = row.querySelector<HTMLElement>(".host-os-icon, .local-shell-icon")!;
    const svg = mark.querySelector("svg")!;
    expect(mark.getBoundingClientRect().width).toBe(18);
    expect(mark.getBoundingClientRect().height).toBe(18);
    expect(svg.getBoundingClientRect().width).toBe(16);
    expect(svg.getBoundingClientRect().height).toBe(16);
    // Logos keep their aspect ratio and fit the shared slot, rather than
    // stretching wide shell or distribution marks into squares.
    const artwork = svg.getBBox();
    const viewBox = svg.viewBox.baseVal;
    const scale = Math.min(16 / viewBox.width, 16 / viewBox.height);
    expect(Math.max(artwork.width, artwork.height) * scale).toBeLessThanOrEqual(17);
    await userEvent.hover(row.querySelector("button")!);
  }
  const heading = container.querySelector("[data-heading-mark] .host-os-icon")!;
  expect(heading.getBoundingClientRect().width).toBe(24);
  expect(heading.querySelector("svg")!.getBoundingClientRect().width).toBe(22);
  await page.screenshot({ path: "../../test-results/identity-logo-scale.png" });
});
