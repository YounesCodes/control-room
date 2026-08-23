import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const overviewSource = readFileSync(new URL("./pages/OverviewPane.tsx", import.meta.url), "utf8");
const terminalSource = readFileSync(
  new URL("./components/TerminalPane.tsx", import.meta.url),
  "utf8",
);
const stylesSource = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const windowCapabilities = JSON.parse(
  readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
) as { permissions: string[] };

describe("application hierarchy", () => {
  it("does not repeat Workspace identity in extra headers or a status rail", () => {
    expect(appSource).not.toContain('className="host-header"');
    expect(appSource).not.toContain('className="status-rail"');
    expect(appSource).not.toContain("workspace-navigation-heading");
    expect(overviewSource).toContain("<h2>Overview</h2>");
  });

  it("keeps connection and page content bounded in wide windows", () => {
    expect(stylesSource).toMatch(/\.workspace-open \.host-list\s*\{[^}]*max-height:/s);
    expect(stylesSource).toMatch(/\.overview-content\s*\{[^}]*max-width: 980px/s);
    expect(stylesSource).toMatch(/\.session-tabs\s*\{[^}]*padding-left: 0;/s);
    expect(stylesSource).toMatch(/\.settings-form\s*\{[^}]*padding-bottom: 8px;/s);
  });

  it("uses host OS marks in navigation and keeps status in the Terminal view", () => {
    expect(appSource.match(/<HostOsIcon/g)).toHaveLength(2);
    expect(appSource).not.toContain("StatusDot");
    expect(terminalSource.match(/<StatusDot/g)).toHaveLength(1);
  });

  it("keeps direct titlebar targets draggable with the required native permission", () => {
    expect(windowCapabilities.permissions).toContain("core:window:allow-start-dragging");
    expect(appSource.match(/data-tauri-drag-region/g)).toHaveLength(4);
  });
});
