/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MAX_SCRATCHPAD_CHARS } from "./scratchpad-draft";

const databaseSource = readFileSync(
  new URL("../../src-tauri/src/database.rs", import.meta.url),
  "utf8",
);
const historyOscSource = readFileSync(new URL("./history-osc.ts", import.meta.url), "utf8");

function rustUsize(name: string): number {
  const match = databaseSource.match(new RegExp(`const ${name}: usize = ([^;]+);`));
  if (!match) throw new Error(`Missing Rust constant ${name}`);
  return evaluateNumeric(match[1]);
}

function typescriptConstant(source: string, name: string): number {
  const match = source.match(new RegExp(`const ${name} = ([^;]+);`));
  if (!match) throw new Error(`Missing TypeScript constant ${name}`);
  return evaluateNumeric(match[1]);
}

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
