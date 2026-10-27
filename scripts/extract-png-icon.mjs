import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function extractPngIcon(icon) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (icon.length < 6 || icon.readUInt16LE(0) !== 0 || icon.readUInt16LE(2) !== 1)
    throw new Error("Invalid ICO header");
  const count = icon.readUInt16LE(4);
  if (icon.length < 6 + count * 16) throw new Error("Truncated ICO directory");
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const size = icon.readUInt32LE(entry + 8);
    const offset = icon.readUInt32LE(entry + 12);
    if (offset < 6 + count * 16 || offset + size > icon.length)
      throw new Error("Invalid ICO image bounds");
    const png = icon.subarray(offset, offset + size);
    if (png.subarray(0, 8).equals(signature)) return png;
  }
  throw new Error("ICO contains no embedded PNG image");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , input, output] = process.argv;
  if (!input || !output) throw new Error("Usage: extract-png-icon.mjs input.ico output.png");
  writeFileSync(output, extractPngIcon(readFileSync(input)));
}
