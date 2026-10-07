import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function sanitize(text, environment = process.env) {
  for (const key of [
    "USERPROFILE",
    "CONTROL_ROOM_TEST_HOST",
    "CONTROL_ROOM_TEST_USER",
    "CONTROL_ROOM_E2E_DATA_DIR",
  ]) {
    const value = environment[key];
    if (value) text = text.split(value).join("[redacted]");
  }
  return text.replace(
    /((?:password|token|secret|private.?key)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,
    (_, prefix, value) =>
      prefix +
      (value.startsWith('"')
        ? '"[redacted]"'
        : value.startsWith("'")
          ? "'[redacted]'"
          : "[redacted]"),
  );
}

function sanitizeDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) sanitizeDirectory(file);
    else if (/\.(?:txt|log|json|html)$/.test(entry.name))
      writeFileSync(file, sanitize(readFileSync(file, "utf8")));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    sanitizeDirectory(resolve("test-results/desktop"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
