import { describe, expect, it } from "vitest";
import { tagBadgeStyle } from "./connection-tag-color";

function luminance(color: string) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  const [red, green, blue] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(left: string, right: string) {
  const lighter = Math.max(luminance(left), luminance(right));
  const darker = Math.min(luminance(left), luminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function blend(foreground: string, background: string, alpha: number) {
  const channels = [1, 3, 5].map((offset) => {
    const front = Number.parseInt(foreground.slice(offset, offset + 2), 16);
    const back = Number.parseInt(background.slice(offset, offset + 2), 16);
    return Math.round(front * alpha + back * (1 - alpha));
  });
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

describe("connection tag colors", () => {
  it("uses the selected hue for a GitHub-style fill and outline", () => {
    expect(tagBadgeStyle("#0000ff")).toMatchObject({
      backgroundColor: "rgb(0 0 255 / 18%)",
      borderColor: "rgb(0 0 255 / 65%)",
    });
    expect(tagBadgeStyle("#ffff00")).toMatchObject({
      backgroundColor: "rgb(255 255 0 / 18%)",
      borderColor: "rgb(255 255 0 / 65%)",
    });
  });

  it("lightens only the label when the selected hue is too dark", () => {
    const darkBlue = tagBadgeStyle("#0000ff");
    expect(darkBlue.color).not.toBe("#0000ff");
    expect(contrastRatio(darkBlue.color as string, "#171745")).toBeGreaterThanOrEqual(4.5);

    const yellow = tagBadgeStyle("#ffff00");
    expect(yellow.color).toBe("#ffff00");
  });

  it("keeps label text readable across the color range", () => {
    let lowestContrast = Number.POSITIVE_INFINITY;
    for (let red = 0; red <= 255; red += 17) {
      for (let green = 0; green <= 255; green += 17) {
        for (let blue = 0; blue <= 255; blue += 17) {
          const color = `#${[red, green, blue]
            .map((channel) => channel.toString(16).padStart(2, "0"))
            .join("")}`;
          const textColor = tagBadgeStyle(color).color as string;
          for (const surface of ["#050505", "#1c1c1c"]) {
            lowestContrast = Math.min(
              lowestContrast,
              contrastRatio(textColor, blend(color, surface, 0.18)),
            );
          }
        }
      }
    }
    expect(lowestContrast).toBeGreaterThanOrEqual(4.5);
  });
});
