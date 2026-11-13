import { resolve } from "node:path";

export const isLinux = process.platform === "linux";
export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";
export const localShellId = isMac ? "zsh" : isLinux ? "bash" : "command-prompt";
export const localShellLabel = isMac ? "zsh" : isLinux ? "Bash" : "Command Prompt";
export const application = resolve(
  process.env.CARGO_TARGET_DIR ?? "src-tauri/target",
  isWindows ? "debug/control-room.exe" : "debug/control-room",
);
export const driverProvider = isMac ? "embedded" : "external";
