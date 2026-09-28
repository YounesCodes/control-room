import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const customHooks = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], {
  encoding: "utf8",
});
if (customHooks.status === 0) {
  console.error(
    "This checkout already uses core.hooksPath. Keep its existing hooks and run npm run test:local-gate manually.",
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

for (const name of ["pre-commit", "pre-push"]) {
  const path = resolve(hooks, name);
  if (existsSync(path)) {
    console.error(
      `${name} already exists. No hooks were replaced. Run npm run test:local-gate manually.`,
    );
    process.exit(1);
  }
}

const hook =
  "#!/bin/sh\n# This checkout's local gate. No VM configuration is stored here.\nnpm run test:local-gate\n";
for (const name of ["pre-commit", "pre-push"]) {
  writeFileSync(resolve(hooks, name), hook, { flag: "wx", mode: 0o755 });
}
console.log("Installed local pre-commit and pre-push hooks for this checkout.");
