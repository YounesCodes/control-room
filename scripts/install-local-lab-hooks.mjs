import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const customHooks = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], {
  encoding: "utf8",
});
if (customHooks.status === 0) {
  console.error(
    "This checkout uses core.hooksPath. Keep its existing hooks and configure check:staged there manually.",
  );
  process.exit(1);
}

const result = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { encoding: "utf8" });
if (result.status !== 0 || !result.stdout.trim()) {
  console.error("Could not find this checkout's Git hooks directory.");
  process.exit(1);
}
const hooks = resolve(result.stdout.trim());
mkdirSync(hooks, { recursive: true });

const legacyHook =
  "#!/bin/sh\n# This checkout's local gate. No VM configuration is stored here.\nnpm run test:local-gate\n";
const commitHook =
  "#!/bin/sh\n# Control Room staged checks. Full validation runs in PR CI.\nnpm run check:staged\n";
for (const name of ["pre-commit", "pre-push"]) {
  const path = resolve(hooks, name);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
    if (existing !== legacyHook && !(name === "pre-commit" && existing === commitHook)) {
      console.error(`${name} is not a managed Control Room hook. No hooks were replaced.`);
      process.exit(1);
    }
  }
}

for (const name of ["pre-commit", "pre-push"]) {
  const path = resolve(hooks, name);
  if (!existsSync(path)) continue;
  const previous = readFileSync(path, "utf8");
  if (previous.replaceAll("\r\n", "\n") === legacyHook) {
    writeFileSync(`${path}.control-room-backup-${Date.now()}`, previous, { flag: "wx" });
  }
  if (name === "pre-push") unlinkSync(path);
}
writeFileSync(resolve(hooks, "pre-commit"), commitHook, { mode: 0o755 });
console.log("Installed staged pre-commit checks and removed the managed full pre-push gate.");
