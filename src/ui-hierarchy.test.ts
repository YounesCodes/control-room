import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const overviewSource = readFileSync(new URL("./pages/OverviewPane.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./pages/SettingsPane.tsx", import.meta.url), "utf8");
const historySource = readFileSync(new URL("./pages/HistoryPane.tsx", import.meta.url), "utf8");
const logsSource = readFileSync(new URL("./pages/LogsPane.tsx", import.meta.url), "utf8");
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

  it("keeps connection search in the sidebar and gives the workspace a compact titlebar", () => {
    expect(appSource).toContain('className="search-field sidebar-search"');
    expect(appSource).not.toContain('className="search-field app-search"');
    expect(stylesSource).toMatch(/\.app-shell\s*\{[^}]*grid-template-rows: 42px/s);
  });

  it("does not reserve a dead favorites column beside the connection filter", () => {
    expect(appSource).toContain('placeholder="Name, group, tag"');
    expect(appSource).toContain('aria-label="Filter connections by name, group, or tag"');
    expect(appSource).toContain("<FolderCog size={18} />");
    expect(stylesSource).toMatch(
      /\.sidebar-filter-row\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) 32px;/s,
    );
    expect(stylesSource).toMatch(
      /\.sidebar-filter-row > \.icon-button\s*\{[^}]*width: 32px;[^}]*height: 32px;/s,
    );
  });

  it("keeps cross-host targets explicit and gives React no command field", () => {
    const dialogSource = readFileSync(
      new URL("./components/CrossHostDialog.tsx", import.meta.url),
      "utf8",
    );
    const operationModel = readFileSync(
      new URL("../src-tauri/src/models.rs", import.meta.url),
      "utf8",
    ).slice(0);
    expect(appSource).toContain("<CrossHostDialog");
    expect(appSource).toContain("Compare hosts");
    // The request carries an operation id and target ids, never a command.
    expect(dialogSource).toContain("operationId: operation.id");
    expect(dialogSource).not.toContain("command:");
    const request = operationModel.slice(
      operationModel.indexOf("pub struct CrossHostRequest"),
      operationModel.indexOf("pub struct CrossHostFact"),
    );
    expect(request).not.toContain("command");
  });

  it("gives Settings an explicit way back to the workspace", () => {
    expect(appSource).toContain("onClose={closeSettings}");
    // Unsaved Settings changes are guarded with an in-app confirm dialog rather
    // than a native window.confirm.
    expect(appSource).not.toContain("window.confirm");
    expect(appSource).toContain('message: "Discard unsaved Settings changes?"');
    expect(settingsSource).toContain('aria-label="Back to terminal"');
  });

  it("keeps local History search separate from the remote integration check", () => {
    const searchLoader = historySource.slice(
      historySource.indexOf("async function loadHistory"),
      historySource.indexOf("useEffect(() =>", historySource.indexOf("async function loadHistory")),
    );
    expect(searchLoader).toContain("api.history(connection.id, search)");
    expect(searchLoader).not.toContain("historyIntegrationStatus");
  });

  it("offers sudo when Docker log source discovery lacks permission", () => {
    expect(logsSource).toContain('type SudoPurpose = "sources" | "stream"');
    expect(logsSource).toContain('setSudoPurpose("sources")');
    expect(logsSource).toContain('loadSources("docker", true, password)');
  });

  it("uses host OS marks and session presence in navigation, with the status dot in the Terminal view", () => {
    expect(appSource.match(/<HostOsIcon/g)).toHaveLength(5);
    expect(appSource).not.toContain("StatusDot");
    // Connection sidebar and Workspace tabs surface live session state as a
    // presence badge on the OS mark; the labelled status dot stays in Terminal.
    expect(appSource).toContain("connectionSessionStates");
    expect(appSource).toContain("className={`presence presence-${workspace.state}`}");
    expect(terminalSource.match(/<StatusDot/g)).toHaveLength(1);
  });

  it("renders bold terminal text as weight so category colors match what the user picks", () => {
    // Bold `01;34` directories / `01;32` prompts must use the chosen base color,
    // not xterm's lightened bright palette, or the Settings color preview lies.
    expect(terminalSource).toContain("drawBoldTextInBrightColors: false");
  });

  it("detects a newly connected host without requiring an Overview visit", () => {
    expect(appSource).toMatch(
      /state === "connected"[\s\S]*detectConnectionCapabilities\(workspace\.connectionId\)/,
    );
  });

  it("keeps direct titlebar targets draggable with the required native permission", () => {
    expect(windowCapabilities.permissions).toContain("core:window:allow-start-dragging");
    expect(appSource.match(/data-tauri-drag-region/g)).toHaveLength(5);
  });

  it("keeps only terminal tabs and the active terminal visible in focus mode", () => {
    expect(appSource).toContain("terminalFocusMode");
    expect(appSource).toContain('aria-label="Exit terminal focus"');
    expect(appSource).toContain('aria-label="Focus terminal"');
    expect(stylesSource).toMatch(
      /\.terminal-focus-mode \.app-bar,[\s\S]*\.terminal-focus-mode \.sidebar\s*\{[^}]*display: none;/,
    );
    expect(stylesSource).toMatch(
      /\.terminal-focus-mode \.terminal-toolbar\s*\{[^}]*display: none;/,
    );
  });

  it("keeps window controls and labeled terminal panes in the focused tab strip", () => {
    expect(appSource.match(/<WindowControls \/>/g)).toHaveLength(2);
    expect(appSource).toContain('aria-label="Split terminal"');
    expect(appSource).toContain("Split vertically");
    expect(appSource).toContain("Split horizontally");
    expect(appSource).toContain("New from Saved Connections");
    expect(appSource).toContain("terminal-pane-label");
    expect(appSource).toContain("Remove from split");
    expect(stylesSource).toContain(".terminal-pane-layout");
  });

  it("puts terminal padding on the xterm element measured by FitAddon", () => {
    expect(stylesSource).toMatch(/\.terminal-container\s*\{[^}]*padding:\s*0;/s);
    expect(stylesSource).toMatch(
      /\.terminal-container > \.xterm\s*\{[^}]*height:\s*100%;[^}]*padding:\s*10px 12px;/s,
    );
    expect(stylesSource).not.toMatch(/\.xterm,\s*\.xterm-viewport\s*\{/s);
  });
});
