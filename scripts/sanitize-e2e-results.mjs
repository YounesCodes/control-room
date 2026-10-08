import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function sanitize(text, environment = process.env) {
  const escape = (value) =>
    Array.from(value, (character) =>
      ".*+?^\u0024{}()|[]\\".includes(character) ? "\\" + character : character,
    ).join("");
  for (const key of [
    "USERPROFILE",
    "CONTROL_ROOM_TEST_HOST",
    "CONTROL_ROOM_TEST_USER",
    "CONTROL_ROOM_E2E_DATA_DIR",
    "GITHUB_WORKSPACE",
  ]) {
    const value = environment[key];
    if (!value) continue;
    for (const variant of [
      value,
      value.replaceAll("\\", "/"),
      JSON.stringify(value).slice(1, -1),
    ]) {
      text = text.replace(new RegExp(escape(variant), "gi"), "[redacted]");
    }
  }
  return text
    .replace(
      /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g,
      "[redacted private key]",
    )
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(
      /((?:[\w-]*(?:password|passwd|pwd|token|secret|private[._-]?key|api[._-]?key)[\w-]*)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,
      (_, prefix, value) =>
        prefix +
        (value.startsWith('"')
          ? '"[redacted]"'
          : value.startsWith("'")
            ? "'[redacted]'"
            : "[redacted]"),
    );
}

export function sanitizeDirectory(directory, output) {
  mkdirSync(output, { recursive: true });
  let failed = false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    try {
      if (entry.isDirectory()) sanitizeDirectory(file, join(output, entry.name));
      else if (entry.isFile() && /\.(?:txt|log|json|jsonl|html)$/i.test(entry.name)) {
        if (statSync(file).size > 1024 * 1024) throw new Error("Diagnostic exceeds 1 MiB");
        const bytes = readFileSync(file);
        if (bytes.includes(0)) throw new Error("Binary diagnostic");
        writeFileSync(
          join(output, entry.name),
          sanitize(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      }
    } catch (error) {
      failed = true;
      console.error(
        `Could not sanitize ${sanitize(entry.name)}: ${sanitize(error.message)}; artifact upload is blocked.`,
      );
    }
  }
  if (failed) throw new Error("Failure diagnostics could not all be sanitized");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    sanitizeDirectory(resolve("test-results/desktop"), resolve("test-results/desktop-sanitized"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
