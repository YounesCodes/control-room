import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const staged = fileURLToPath(new URL("./check-staged.mjs", import.meta.url));
const installer = fileURLToPath(new URL("./install-local-lab-hooks.mjs", import.meta.url));
const directories = [];
function repository() {
  const root = mkdtempSync(join(tmpdir(), "control-room-hooks-"));
  directories.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}
function run(script, root) {
  return execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" });
}
afterEach(() =>
  directories.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
);

describe("development hooks", () => {
  it("checks staged content rather than unstaged edits", () => {
    const root = repository();
    const path = join(root, "example.json");
    writeFileSync(path, '{ "ok": true }\n');
    execFileSync("git", ["add", "."], { cwd: root });
    writeFileSync(path, '{"ok":false}');
    expect(() => run(staged, root)).not.toThrow();
    execFileSync("git", ["add", "."], { cwd: root });
    writeFileSync(path, '{ "ok": true }\n');
    expect(() => run(staged, root)).toThrow();
    expect(readFileSync(path, "utf8")).toBe('{ "ok": true }\n');
  });
  it("backs up the old full hooks, removes the duplicate push gate, and can run twice", () => {
    const root = repository();
    const hooks = join(root, ".git", "hooks");
    const old =
      "#!/bin/sh\n# This checkout's local gate. No VM configuration is stored here.\nnpm run test:local-gate\n";
    for (const name of ["pre-commit", "pre-push"]) writeFileSync(join(hooks, name), old);
    run(installer, root);
    run(installer, root);
    expect(readFileSync(join(hooks, "pre-commit"), "utf8")).toContain("npm run check:staged");
    expect(existsSync(join(hooks, "pre-push"))).toBe(false);
    expect(readdirSync(hooks).filter((name) => name.includes("control-room-backup"))).toHaveLength(
      2,
    );
  });
  it("preserves unrelated hooks without partially installing", () => {
    const root = repository();
    const hook = join(root, ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\necho custom\n");
    expect(() => run(installer, root)).toThrow();
    expect(readFileSync(hook, "utf8")).toContain("echo custom");
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });
  it("refuses a custom hooks directory", () => {
    const root = repository();
    execFileSync("git", ["config", "core.hooksPath", ".custom-hooks"], { cwd: root });
    expect(() => run(installer, root)).toThrow();
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });
});
