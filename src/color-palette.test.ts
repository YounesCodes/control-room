/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesSource = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const settingsModelSource = readFileSync(
  new URL("../src-tauri/src/models.rs", import.meta.url),
  "utf8",
);
/** Status colors, plus the OS and shell brand hues that identity marks reveal
 *  on hover or selection: the distribution logos' official colors (Alpine,
 *  CentOS, and AlmaLinux lightened to read on the dark surfaces), Windows
 *  blue, PowerShell-family blue, and Git orange. Shell and OS marks reveal
 *  their brand colors on hover, focus, and selection. */
const semanticUiColors = [
  "#42d17a",
  "#d6a84a",
  "#ef5b6b",
  "#0078d4",
  "#0288d1",
  "#5391fe",
  "#f05032",
  "#d70a53",
  "#e95420",
  "#51a2da",
  "#1793d1",
  "#73ba25",
  "#6293ac",
  "#86be43",
  "#557c94",
  "#ee0000",
  "#8887b4",
  "#10b981",
  "#7ea4bf",
  "#5277c3",
  "#35bf5c",
  "#5aa48f",
  "#f80000",
  "#ff9900",
];

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
  it("allows only status colors and identity brand hues outside neutral UI colors", () => {
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
    expect(settingsModelSource).toContain('terminal_foreground: "#dddddd"');
    expect(settingsModelSource).toContain('terminal_red: "#ff5555"');
    expect(settingsModelSource).toContain('terminal_green: "#55ff55"');
    expect(settingsModelSource).toContain('terminal_yellow: "#ffff55"');
    expect(settingsModelSource).toContain('terminal_blue: "#5555ff"');
    expect(settingsModelSource).toContain('terminal_magenta: "#ff55ff"');
    expect(settingsModelSource).toContain('terminal_cyan: "#55ffff"');
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
    for (const textToken of ["text", "text-muted", "text-faint"]) {
      for (const surfaceToken of [
        "app-bg",
        "sidebar-bg",
        "surface-chrome",
        "surface-raised",
        "surface-overlay",
        "fill-hover",
        "fill-active",
        "fill-selected",
      ]) {
        expect(
          contrastRatio(paletteValue(textToken), paletteValue(surfaceToken)),
          `${textToken} on ${surfaceToken}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const semanticColor of ["success", "warning", "failure"]) {
      expect(
        contrastRatio(paletteValue(semanticColor), paletteValue("app-bg")),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps informative interface text at least 10 pixels", () => {
    const sizes = [...stylesSource.matchAll(/font-size:\s*([\d.]+)px/g)].map((match) =>
      Number(match[1]),
    );
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10);
  });
});
