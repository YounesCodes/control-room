import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { affectsMacBundle, affectsSoftware, frontendOnly } from "./software-changes.mjs";

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

test("Mac bundle builds follow packaging inputs in mixed PRs", () => {
  const routine = [
    "src/App.tsx",
    "src-tauri/src/lib.rs",
    "e2e/settings.spec.ts",
    "docs/package.json",
    "README.md",
  ];
  assert.equal(affectsMacBundle(routine), false);
  for (const path of [
    "src-tauri/tauri.macos.conf.json",
    "src-tauri/icons/icon.icns",
    "src-tauri/build.rs",
    "src-tauri/Cargo.lock",
    "src-tauri/Cargo.toml",
    "src-tauri/Info.plist",
    "src-tauri/resources/help.md",
    "package-lock.json",
    "package.json",
    "vite.config.ts",
    "tsconfig.app.json",
    ".cargo/config.toml",
    "scripts/verify-updater-signature.mjs",
    ".github/workflows/release.yml",
    ".github/workflows/macos.yml",
    ".github/scripts/software-changes.mjs",
  ]) {
    assert.equal(affectsMacBundle([...routine, path]), true, path);
  }
});

test("pushes and other events never skip jobs as frontend-only", () => {
  for (const eventName of ["push", "workflow_dispatch", "merge_group", undefined]) {
    assert.equal(frontendOnly(["src/styles.css"], eventName), false, String(eventName));
  }
});

test("the CLI classifies PR and push diffs", () => {
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
    const run = (eventName, baseSha = base, headSha = head) => {
      const output = join(dir, "output");
      writeFileSync(output, "");
      execFileSync(process.execPath, [script, "--check"], {
        cwd: dir,
        env: {
          ...process.env,
          BASE_SHA: baseSha,
          HEAD_SHA: headSha,
          EVENT_NAME: eventName,
          GITHUB_OUTPUT: output,
        },
      });
      return readFileSync(output, "utf8");
    };
    assert.equal(run("pull_request"), "software=true\nfrontend_only=true\nmacos_bundle=false\n");
    assert.equal(run("push"), "software=true\nfrontend_only=false\nmacos_bundle=true\n");

    assert.equal(
      run("pull_request", "invalid"),
      "software=true\nfrontend_only=false\nmacos_bundle=true\n",
    );

    git("checkout", "-q", "--detach", base);
    writeFileSync(join(dir, "README.md"), "# Docs\n");
    git("add", "README.md");
    git("commit", "-qm", "docs");
    const docsHead = git("rev-parse", "HEAD");
    assert.equal(
      run("pull_request", head, docsHead),
      "software=false\nfrontend_only=false\nmacos_bundle=false\n",
    );

    git("checkout", "-q", "--detach", head);
    git("mv", "src/styles.css", "styles.md");
    git("commit", "-qm", "move styles");
    const movedHead = git("rev-parse", "HEAD");
    assert.equal(
      run("pull_request", head, movedHead),
      "software=true\nfrontend_only=true\nmacos_bundle=false\n",
    );
    writeFileSync(join(dir, "package.json"), "{}\n");
    git("add", "package.json");
    git("commit", "-qm", "package manifest");
    const packagingHead = git("rev-parse", "HEAD");
    git("mv", "package.json", "retired.md");
    git("commit", "-qm", "retire manifest");
    assert.equal(
      run("pull_request", packagingHead, git("rev-parse", "HEAD")),
      "software=true\nfrontend_only=false\nmacos_bundle=true\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
