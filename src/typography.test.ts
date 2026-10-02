import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesSource = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");

describe("typography", () => {
  it("uses Inter Variable for UI body with system fallbacks", () => {
    expect(stylesSource).toContain("--font-ui:");
    expect(stylesSource).toContain('"Inter Variable"');
    expect(stylesSource).toContain("font-family: var(--font-ui);");
    expect(stylesSource).toContain('"Segoe UI Variable Text"');
  });

  it("reserves Space Grotesk for headings and display sizes", () => {
    expect(stylesSource).toContain("--font-display:");
    expect(stylesSource).toContain('"Space Grotesk"');
    expect(stylesSource).toMatch(
      /h1,\s*\nh2,\s*\nh3\s*\{[^}]*font-family:\s*var\(--font-display\)/,
    );
  });

  it("bundles Inter locally instead of loading a remote font", () => {
    expect(mainSource).toContain("@fontsource-variable/inter/opsz.css");
    expect(stylesSource).not.toMatch(/@import\s+url\(['"]?https?:/);
    expect(stylesSource).not.toContain("fonts.googleapis.com");
  });

  it("keeps Cascadia Mono for terminal and technical values", () => {
    expect(stylesSource).toContain('"Cascadia Mono"');
    expect(stylesSource).toMatch(
      /code,\s*\n\.technical,\s*\n\.log-output\s*\{[^}]*"Cascadia Mono"/,
    );
  });
});
