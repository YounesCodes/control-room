import { readdir, readFile } from "node:fs/promises";
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
    const sheets = await readdir(path.join(root, "src/styles"), { recursive: true });
    const styles = (
      await Promise.all(
        sheets
          .filter((sheet) => sheet.endsWith(".css"))
          .map((sheet) => readFile(path.join(root, "src/styles", sheet), "utf-8")),
      )
    ).join("\n");
    // WebView2 loads CSS background images, including data: URLs, under img-src.
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
