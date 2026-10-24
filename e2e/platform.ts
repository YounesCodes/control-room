import { resolve } from "node:path";

export const isMac = process.platform === "darwin";
export const localShellId = isMac ? "zsh" : "command-prompt";
export const localShellLabel = isMac ? "zsh" : "Command Prompt";
export const application = resolve(
  process.env.CARGO_TARGET_DIR ?? "src-tauri/target",
  isMac ? "debug/control-room" : "debug/control-room.exe",
);
export const driverProvider = isMac ? "embedded" : "external";
