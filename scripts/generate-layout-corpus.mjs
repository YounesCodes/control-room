import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["vitest", "run", "--dir", "src", "terminal-layout.property"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, CONTROL_ROOM_WRITE_LAYOUT_CORPUS: "1" },
});
process.exitCode = result.status ?? 1;
