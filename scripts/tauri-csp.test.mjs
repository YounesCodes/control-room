import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

const readCsp = async () => {
  const config = JSON.parse(await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf-8"));
  const csp = config?.app?.security?.csp;
  expect(typeof csp).toBe("string");
  return csp;
};

const cspDirective = (csp, name) => {
  const directive = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.split(/\s+/)[0]?.toLowerCase() === name);
  return directive?.split(/\s+/).slice(1) ?? null;
};

describe("packaged app CSP", () => {
  it("allows the data: images the stylesheet draws", async () => {
    const csp = await readCsp();
    const styles = await readFile(path.join(root, "src/styles.css"), "utf-8");
    // The checkbox checkmark, the indeterminate dash, and the select chevron
    // are drawn as data: URL background images. WebView2 loads background
    // images under img-src, so a CSP without the data: source drops every
    // checkmark in the packaged app.
    const dataImageUrls = [...styles.matchAll(/url\(["']?data:/g)].length;
    expect(dataImageUrls).toBeGreaterThan(0);
    expect(cspDirective(csp, "img-src")).toContain("data:");
  });

  it("keeps the required Tauri sources for assets and IPC", async () => {
    const csp = await readCsp();
    expect(cspDirective(csp, "img-src")).toContain("'self'");
    expect(cspDirective(csp, "img-src")).toContain("asset:");
    expect(cspDirective(csp, "connect-src")).toContain("ipc:");
  });
});
