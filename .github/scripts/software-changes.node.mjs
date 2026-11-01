import { test } from "node:test";
import assert from "node:assert/strict";
import { affectsSoftware } from "./software-changes.mjs";
test("documentation and repository guidance skip software jobs", () => {
  assert.equal(
    affectsSoftware([
      "README.md",
      "AGENTS.md",
      "DESIGN.md",
      "docs/package.json",
      "docs/src/assets/screenshots/terminal.png",
      "LICENSE",
    ]),
    false,
  );
});
test("code, builds, workflows, tests, and unknown files run software jobs", () => {
  for (const path of [
    "src/App.tsx",
    "src-tauri/src/lib.rs",
    "package-lock.json",
    ".github/workflows/ci.yml",
    ".github/scripts/software-changes.mjs",
    "e2e/settings.spec.ts",
    "unknown.config",
    "amdx",
  ]) {
    assert.equal(affectsSoftware(["README.md", path]), true, path);
  }
});
