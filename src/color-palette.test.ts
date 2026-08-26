/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesSource = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const terminalThemeSource = readFileSync(
  new URL("./lib/terminal-theme.ts", import.meta.url),
  "utf8",
);
const semanticUiColors = ["#42d17a", "#d6a84a", "#ef5b6b"];

function hexChannels(value: string) {
  const digits = value.slice(1);
  const expanded =
    digits.length === 3
      ? digits
          .split("")
          .map((digit) => digit.repeat(2))
          .join("")
      : digits;
  return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16));
}

function isNeutral(channels: number[]) {
  return Math.max(...channels) - Math.min(...channels) <= 4;
}

function relativeLuminance(value: string) {
  const channels = hexChannels(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function paletteValue(name: string) {
  const match = stylesSource.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{3}(?:[0-9a-f]{3})?)`, "i"));
  if (!match) throw new Error(`Missing palette variable --${name}`);
  return match[1];
}

describe("monochrome application palette", () => {
  it("allows only semantic green, amber, and red outside neutral UI colors", () => {
    const nonNeutralColors: string[] = [];

    for (const match of stylesSource.matchAll(/#[0-9a-f]{3}(?:[0-9a-f]{3})?\b/gi)) {
      if (!isNeutral(hexChannels(match[0]))) nonNeutralColors.push(match[0].toLowerCase());
    }
    for (const match of stylesSource.matchAll(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/gi)) {
      const channels = match.slice(1, 4).map(Number);
      if (!isNeutral(channels)) nonNeutralColors.push(match[0].toLowerCase());
    }

    expect([...new Set(nonNeutralColors)].sort()).toEqual([...semanticUiColors].sort());
  });

  it("preserves ANSI colors for remote terminal content", () => {
    expect(terminalThemeSource).toContain('terminalRed: "#ff6f7d"');
    expect(terminalThemeSource).toContain('terminalGreen: "#52cf91"');
    expect(terminalThemeSource).toContain('terminalYellow: "#e8c56c"');
    expect(terminalThemeSource).toContain('terminalBlue: "#55aef2"');
  });

  it("keeps the main text hierarchy above WCAG AA contrast", () => {
    expect(contrastRatio(paletteValue("text"), paletteValue("app-bg"))).toBeGreaterThanOrEqual(7);
    expect(
      contrastRatio(paletteValue("text-muted"), paletteValue("app-bg")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(paletteValue("text-faint"), paletteValue("sidebar-bg")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#000", paletteValue("accent"))).toBeGreaterThanOrEqual(7);
    for (const semanticColor of ["success", "warning", "failure"]) {
      expect(
        contrastRatio(paletteValue(semanticColor), paletteValue("app-bg")),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
