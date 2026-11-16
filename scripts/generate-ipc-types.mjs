import { spawnSync } from "node:child_process";

const result = spawnSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--lib",
    "ipc_contract::generated_typescript_matches_the_rust_ipc_contract",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, CONTROL_ROOM_WRITE_IPC_TYPES: "1" },
  },
);
process.exitCode = result.status ?? 1;
