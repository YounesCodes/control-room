import type { CSSProperties } from "react";

type Rgb = [number, number, number];

const TAG_FILL_PERCENT = 14;
const TAG_BORDER_PERCENT = 58;
const TAG_FILL_ALPHA = TAG_FILL_PERCENT / 100;
const MINIMUM_TAG_CONTRAST = 4.5;
const TAG_SURFACES: Rgb[] = [
  [5, 5, 5],
  [28, 28, 28],
];

function linearChannel(channel: number) {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function parseHex(color: string): Rgb {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16)) as Rgb;
}

function toHex(channels: Rgb) {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function luminance(channels: Rgb) {
  const [red, green, blue] = channels.map(linearChannel);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(left: Rgb, right: Rgb) {
  const lighter = Math.max(luminance(left), luminance(right));
  const darker = Math.min(luminance(left), luminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function blend(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return foreground.map((channel, index) =>
    Math.round(channel * alpha + background[index] * (1 - alpha)),
  ) as Rgb;
}

export function tagDisplayColor(color: string) {
  const original = parseHex(color);
  for (let percentage = 0; percentage <= 100; percentage += 1) {
    const candidate = original.map((channel) =>
      Math.round(channel + (255 - channel) * (percentage / 100)),
    ) as Rgb;
    const readable = TAG_SURFACES.every(
      (surface) =>
        contrastRatio(candidate, blend(candidate, surface, TAG_FILL_ALPHA)) >= MINIMUM_TAG_CONTRAST,
    );
    if (readable) return toHex(candidate);
  }
  return "#ffffff";
}

export function tagBadgeStyle(color: string): CSSProperties {
  const displayColor = tagDisplayColor(color);
  const channels = parseHex(displayColor).join(" ");
  return {
    color: displayColor,
    backgroundColor: `rgb(${channels} / ${TAG_FILL_PERCENT}%)`,
    borderColor: `rgb(${channels} / ${TAG_BORDER_PERCENT}%)`,
  };
}
