import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

function isDocumentation(path) {
  return (
    /[.]mdx?$/i.test(path) ||
    path.startsWith("docs/") ||
    path === "LICENSE" ||
    path.startsWith(".github/ISSUE_TEMPLATE/") ||
    path.startsWith(".github/PULL_REQUEST_TEMPLATE")
  );
}

export function affectsSoftware(paths) {
  return paths.some((path) => !isDocumentation(path));
}

const macBundleInputs = [
  /^(?:package\.json|package-lock\.json|\.npmrc|index\.html)$/,
  /^(?:vite\.config\.|tsconfig(?:\.|$))/,
  /^(?:\.cargo\/|rust-toolchain(?:\.toml)?$|Cargo\.(?:toml|lock)$)/,
  /^(?:assets|public)\//,
  /^src-tauri\/(?!src\/|tests\/|test-fixtures\/)/,
  /^src-tauri\/src\/updater[._/]/,
  /^\.github\/workflows\/(?:macos|release|verify-signing)\.yml$/,
  /^\.github\/scripts\/software-changes(?:\.node)?\.mjs$/,
  /^scripts\/[^/]*(?:release|sign|bundle|updater|macos-installer|extract-png-icon)/,
];

export function affectsMacBundle(paths) {
  return paths.some((path) => macBundleInputs.some((pattern) => pattern.test(path)));
}

// React sources, styles, assets, and their tests live under src/. Nothing else
// counts: src-tauri/, package files, lockfiles, e2e/, scripts/, workflows,
// build configs, and the UI review harness all keep the full suite.
export function frontendOnly(paths, eventName) {
  return (
    eventName === "pull_request" &&
    affectsSoftware(paths) &&
    paths.every((path) => isDocumentation(path) || path.startsWith("src/"))
  );
}

if (process.argv.includes("--check")) {
  const { BASE_SHA, HEAD_SHA, EVENT_NAME, GITHUB_OUTPUT } = process.env;
  const valid = (value) => /^[a-f0-9]{40}$/.test(value ?? "") && !/^0+$/.test(value);
  let software = true;
  let frontend = false;
  let macBundle = true;
  if (valid(BASE_SHA) && valid(HEAD_SHA)) {
    const revisions =
      EVENT_NAME === "pull_request" ? [BASE_SHA + "..." + HEAD_SHA] : [BASE_SHA, HEAD_SHA];
    // Count the old path of a moved file so moving code into docs still runs CI.
    const paths = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", ...revisions], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
    software = affectsSoftware(paths);
    macBundle = EVENT_NAME !== "pull_request" || affectsMacBundle(paths);
    frontend = frontendOnly(paths, EVENT_NAME);
  }
  const outputs = `software=${software}\nfrontend_only=${frontend}\nmacos_bundle=${macBundle}\n`;
  process.stdout.write(outputs);
  appendFileSync(GITHUB_OUTPUT, outputs);
}
