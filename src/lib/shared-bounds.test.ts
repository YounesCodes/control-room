/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MAX_SCRATCHPAD_CHARS } from "./scratchpad-draft";

/// Some bounds are deliberately written twice: Rust enforces them because it
/// cannot trust the frontend, and the frontend needs the same number to cap a
/// textarea or drop an oversized event before it is sent. Collapsing them would
/// put a trust-boundary check in the untrusted half, so both copies stay and
/// this file pins them together instead. When they drift the failure is silent:
/// the editor accepts text the backend then refuses, or valid history is
/// dropped in the browser for a limit Rust no longer has.
const databaseSource = readFileSync(
  new URL("../../src-tauri/src/database.rs", import.meta.url),
  "utf8",
);
const historyOscSource = readFileSync(new URL("./history-osc.ts", import.meta.url), "utf8");

/** Value of a `const NAME: usize = <expr>;` line, evaluated as arithmetic. */
function rustUsize(name: string): number {
  const match = databaseSource.match(new RegExp(`const ${name}: usize = ([^;]+);`));
  if (!match) throw new Error(`Missing Rust constant ${name}`);
  return evaluateNumeric(match[1]);
}

/** Value of a `const NAME = <expr>;` line in a TypeScript module. */
function typescriptConstant(source: string, name: string): number {
  const match = source.match(new RegExp(`const ${name} = ([^;]+);`));
  if (!match) throw new Error(`Missing TypeScript constant ${name}`);
  return evaluateNumeric(match[1]);
}

/** Only digits, underscores, and `*` appear in these bounds. */
function evaluateNumeric(expression: string): number {
  const cleaned = expression.replace(/_/g, "").trim();
  if (!/^[\d\s*]+$/.test(cleaned)) throw new Error(`Unsupported bound expression: ${expression}`);
  return cleaned.split("*").reduce((total, part) => total * Number(part.trim()), 1);
}

describe("bounds shared across the Rust boundary", () => {
  it("caps the Scratchpad editor at the size the database accepts", () => {
    expect(MAX_SCRATCHPAD_CHARS).toBe(rustUsize("MAX_SCRATCHPAD_CHARS"));
  });

  it("drops oversized history commands at the same size the database refuses", () => {
    expect(typescriptConstant(historyOscSource, "MAX_HISTORY_COMMAND_BYTES")).toBe(
      rustUsize("MAX_HISTORY_COMMAND_BYTES"),
    );
  });

  it("drops oversized history working directories at the size the database refuses", () => {
    expect(typescriptConstant(historyOscSource, "MAX_HISTORY_CWD_BYTES")).toBe(
      rustUsize("MAX_HISTORY_CWD_BYTES"),
    );
  });
});
