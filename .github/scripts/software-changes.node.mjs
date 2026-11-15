import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { affectsSoftware, frontendOnly } from "./software-changes.mjs";

const script = fileURLToPath(new URL("./software-changes.mjs", import.meta.url));

test("documentation and repository guidance skip software jobs", () => {
  const docs = [
    "README.md",
    "AGENTS.md",
    "DESIGN.md",
    "docs/package.json",
    "docs/src/assets/screenshots/terminal.png",
    "LICENSE",
  ];
  assert.equal(affectsSoftware(docs), false);
  assert.equal(frontendOnly(docs, "pull_request"), false);
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

test("pull requests that change only React sources and tests are frontend-only", () => {
  for (const paths of [
    ["src/styles.css"],
    ["src/styles.css", "src/scrollbars.browser.test.tsx"],
    ["src/components/Terminal.tsx", "src/test/fixtures.ts", "src/assets/container-logos/caddy.svg"],
    ["src/App.tsx", "docs/terminal.md", "DESIGN.md"],
  ]) {
    assert.equal(frontendOnly(paths, "pull_request"), true, paths.join(", "));
  }
});

test("Rust, packaging, tooling, and mixed changes keep the full suite", () => {
  for (const path of [
    "src-tauri/src/lib.rs",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.lock",
    "package.json",
    "package-lock.json",
    "e2e/settings.spec.ts",
    "scripts/ui-review.mjs",
    ".github/workflows/ci.yml",
    ".github/scripts/software-changes.mjs",
    "vite.config.ts",
    "index.html",
    "ui-review/index.html",
    "wdio.conf.ts",
    "srcfile.ts",
    "unknown.config",
  ]) {
    assert.equal(frontendOnly(["src/App.tsx", path], "pull_request"), false, path);
  }
});

test("pushes and other events never skip jobs as frontend-only", () => {
  for (const eventName of ["push", "workflow_dispatch", "merge_group", undefined]) {
    assert.equal(frontendOnly(["src/styles.css"], eventName), false, String(eventName));
  }
});

test("the CLI writes both outputs from a git diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "software-changes-"));
  try {
    const git = (...args) =>
      execFileSync("git", ["-c", "user.name=ci", "-c", "user.email=ci@example.com", ...args], {
        cwd: dir,
        encoding: "utf8",
      }).trim();
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "styles.css"), "body {}\n");
    git("add", ".");
    git("commit", "-q", "-m", "styles");
    const head = git("rev-parse", "HEAD");
    const run = (eventName) => {
      const output = join(dir, `output-${eventName}`);
      execFileSync(process.execPath, [script, "--check"], {
        cwd: dir,
        env: {
          ...process.env,
          BASE_SHA: base,
          HEAD_SHA: head,
          EVENT_NAME: eventName,
          GITHUB_OUTPUT: output,
        },
      });
      return readFileSync(output, "utf8");
    };
    assert.equal(run("pull_request"), "software=true\nfrontend_only=true\n");
    assert.equal(run("push"), "software=true\nfrontend_only=false\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
