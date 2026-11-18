import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stylesSource } from "./test/stylesheets";

function code(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function productionSources(directory = new URL("./", import.meta.url)): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return productionSources(new URL(`${entry.name}/`, directory));
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [new URL(entry.name, directory)];
  });
}

function calledWindowMethods(): string[] {
  const called = new Set<string>();
  for (const file of productionSources()) {
    const source = readFileSync(file, "utf8");
    if (!source.includes('from "@tauri-apps/api/window"')) continue;
    for (const [, binding] of source.matchAll(/(\w+)\s*=[^;]*getCurrentWindow\(\)/g)) {
      const call = new RegExp(String.raw`\b${binding}\.(\w+)\s*\(`, "g");
      for (const [, method] of source.matchAll(call)) {
        called.add(method);
      }
    }
  }
  return [...called].sort();
}

function importedDialogFunctions(): string[] {
  const named = new Set<string>();
  for (const file of productionSources()) {
    const source = readFileSync(file, "utf8");
    for (const [, clause] of source.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*"@tauri-apps\/plugin-dialog"/g,
    )) {
      for (const specifier of clause.split(",")) {
        const name = specifier.split(/\bas\b/)[0].trim();
        if (name) named.add(name);
      }
    }
  }
  return [...named].sort();
}

function cssRule(selector: string): string {
  const start = stylesSource.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no stylesheet has a "${selector}" rule`);
  return stylesSource.slice(start, stylesSource.indexOf("}", start));
}

const windowCapabilities = JSON.parse(
  readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
) as { permissions: string[] };
const linuxWindowCapabilities = JSON.parse(code("../src-tauri/capabilities/linux-window.json")) as {
  platforms: string[];
  permissions: string[];
};

describe("contracts shared with the native app and docs site", () => {
  it("opens the same documentation URL that the docs site publishes", () => {
    const config = code("../docs/astro.config.mjs");
    const site = config.match(/site:\s*"([^"]+)"/)?.[1];
    const base = config.match(/base:\s*"([^"]+)"/)?.[1];
    expect(site, "docs/astro.config.mjs must declare site").toBeDefined();
    expect(base, "docs/astro.config.mjs must declare base").toBeDefined();
    const url = code("../src-tauri/src/documentation.rs").match(
      /DOCUMENTATION_URL:\s*&str\s*=\s*"([^"]+)"/,
    )?.[1];
    expect(url, "DOCUMENTATION_URL must match the published docs URL").toBe(
      new URL(`${base}/`, site).href,
    );
  });

  it("registers every frontend IPC command in the Rust handler", () => {
    const called = [
      ...code("./lib/api.ts").matchAll(
        /\b(?:invoke|invokeRemoteInspection)(?:<[^\n(]*>)?\(\s*"([a-z_]+)"/g,
      ),
    ].map((match) => match[1]);
    const handlers = code("../src-tauri/src/lib.rs")
      .split("tauri::generate_handler![")[1]
      ?.split("])")[0]
      .matchAll(/^\s*[a-z_]+::([a-z_]+),/gm);
    const registered = new Set([...(handlers ?? [])].map((match) => match[1]));
    expect(called.length, "api.ts command extraction found too few commands").toBeGreaterThan(40);
    for (const command of called) {
      expect(
        registered.has(command),
        `${command} is called in api.ts but missing from tauri::generate_handler!`,
      ).toBe(true);
    }
  });

  it("grants the native permission behind data-tauri-drag-region titlebar targets", () => {
    expect(windowCapabilities.permissions).toContain("core:window:allow-start-dragging");
  });

  it("grants a native permission for every window control the frontend uses", () => {
    const called = calledWindowMethods().filter((method) => !/^(is|on)[A-Z]/.test(method));
    expect(windowCapabilities.permissions).toContain("core:default");
    expect(called).toEqual(["close", "minimize", "startResizeDragging", "toggleMaximize"]);
    expect(linuxWindowCapabilities.platforms).toEqual(["linux"]);
    expect(
      JSON.parse(code("../src-tauri/tauri.linux.conf.json")).app.security.capabilities,
    ).toContain("linux-window");
    for (const method of called) {
      const permission = `core:window:allow-${method.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      expect(
        (method === "startResizeDragging" ? linuxWindowCapabilities : windowCapabilities)
          .permissions,
        `window.${method} is called but not permitted`,
      ).toContain(permission);
    }
  });

  it("grants a native permission for every dialog the frontend opens", () => {
    const imported = importedDialogFunctions();
    expect(imported.length).toBeGreaterThan(0);
    for (const name of imported) {
      expect(
        windowCapabilities.permissions,
        `dialog.${name} is called but not permitted`,
      ).toContain(`dialog:allow-${name}`);
    }
  });
});

describe("terminal stylesheet contracts", () => {
  it("puts terminal padding on the xterm element that FitAddon measures", () => {
    expect(cssRule(".terminal-container"), "padding here shrinks rows FitAddon cannot see").toMatch(
      /padding:\s*0;/,
    );
    expect(cssRule(".terminal-container > .xterm")).toMatch(/height:\s*100%;/);
    expect(cssRule(".terminal-container > .xterm")).toMatch(/padding:\s*10px 12px;/);
  });

  it("overlays terminal search instead of resizing the terminal", () => {
    expect(cssRule(".terminal-search")).toMatch(/position:\s*absolute;/);
  });
});
