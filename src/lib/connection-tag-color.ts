import type { CSSProperties } from "react";

function linearChannel(channel: number) {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function tagTextColor(background: string) {
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(background.slice(offset, offset + 2), 16),
  );
  const luminance =
    0.2126 * linearChannel(channels[0]) +
    0.7152 * linearChannel(channels[1]) +
    0.0722 * linearChannel(channels[2]);
  const contrastWithBlack = (luminance + 0.05) / 0.05;
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  return contrastWithBlack >= contrastWithWhite ? "#000000" : "#ffffff";
}

export function tagBadgeStyle(color: string): CSSProperties {
  return {
    backgroundColor: color,
    color: tagTextColor(color),
  };
}
