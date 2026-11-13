import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { ipc, runtime, terminalContains } from "./helpers";

const mac = process.platform === "darwin";
const windows = process.platform === "win32";
function powershell(action: string, value = "", extra: string[] = []) {
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve("scripts/native-input.ps1"),
      "-Action",
      action,
      "-Value",
      value,
      ...extra,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
    },
  );
}
export function readClipboard() {
  if (windows) return powershell("clipboard-read");
  try {
    return execFileSync(
      mac ? "/usr/bin/pbpaste" : "xclip",
      mac ? [] : ["-selection", "clipboard", "-o"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    if (!mac && /target STRING not available/.test(String((error as { stderr?: unknown }).stderr)))
      return "";
    throw error;
  }
}
export function writeClipboard(text: string) {
  if (windows) {
    powershell("clipboard-write", Buffer.from(text).toString("base64"));
    return;
  }
  execFileSync(mac ? "/usr/bin/pbcopy" : "xclip", mac ? [] : ["-selection", "clipboard"], {
    input: text,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "inherit"],
    timeout: 5000,
  });
}
export async function nativeKey(shortcut: string) {
  const parts = shortcut.toLowerCase().split("+");
  const key = parts.pop()!;
  const modifiers = parts.map((modifier) =>
    modifier === "primary" ? (mac ? "command" : "ctrl") : modifier,
  );
  if (windows) {
    const special: Record<string, string> = {
      enter: "{ENTER}",
      escape: "{ESC}",
      home: "{HOME}",
      end: "{END}",
      up: "{UP}",
      down: "{DOWN}",
      left: "{LEFT}",
      right: "{RIGHT}",
      tab: "{TAB}",
    };
    powershell(
      "key",
      modifiers.map((modifier) => ({ ctrl: "^", shift: "+", alt: "%" })[modifier]).join("") +
        (special[key] ?? key),
    );
  } else if (mac) {
    const codes: Record<string, number> = {
      p: 35,
      t: 17,
      r: 15,
      w: 13,
      c: 8,
      v: 9,
      f: 3,
      enter: 36,
      escape: 53,
      home: 115,
      end: 119,
      up: 126,
      down: 125,
      left: 123,
      right: 124,
      tab: 48,
    };
    if (codes[key] === undefined) throw new Error(`No native macOS key code for ${key}`);
    const modifierNames: Record<string, string> = {
      command: "command down",
      ctrl: "control down",
      shift: "shift down",
      alt: "option down",
    };
    execFileSync(
      "osascript",
      [
        "-e",
        `tell application "System Events" to key code ${codes[key]}${modifiers.length ? " using {" + modifiers.map((modifier) => modifierNames[modifier]).join(", ") + "}" : ""}`,
      ],
      { timeout: 10000 },
    );
  } else
    execFileSync(
      "xdotool",
      [
        "key",
        "--clearmodifiers",
        [
          ...modifiers,
          key === "enter"
            ? "Return"
            : key === "escape"
              ? "Escape"
              : key === "home"
                ? "Home"
                : key === "end"
                  ? "End"
                  : key === "tab"
                    ? "Tab"
                    : ["up", "down", "left", "right"].includes(key)
                      ? key[0].toUpperCase() + key.slice(1)
                      : key,
        ].join("+"),
      ],
      { timeout: 5000 },
    );
}
export async function focusNativeApp() {
  const pid = (await runtime()).appPid;
  if (windows) powershell("focus", String(pid));
  else if (mac)
    execFileSync(
      "osascript",
      [
        "-e",
        `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
      ],
      { timeout: 10000 },
    );
  else {
    const id = execFileSync(
      "xdotool",
      ["search", "--onlyvisible", "--pid", String(pid), "--name", "^Control Room$"],
      { encoding: "utf8", timeout: 5000 },
    )
      .trim()
      .split("\n")[0];
    execFileSync("xdotool", ["windowactivate", "--sync", id], { timeout: 5000 });
  }
  await browser.waitUntil(() => ipc<boolean>("plugin:window|is_focused", { label: "main" }));
}
export async function openNativeShell() {
  const catalog = await ipc<{ profiles: { id: string; label: string; elevated: boolean }[] }>(
    "list_local_shells",
  );
  const shell = catalog.profiles.find(
    (profile) => profile.id === (windows ? "command-prompt" : mac ? "zsh" : "bash"),
  );
  if (!shell) throw new Error("The native input fixture's shell is unavailable");
  await $('button[aria-label="New terminal"]').click();
  await $(`.new-terminal-menu [aria-label="Local terminals: ${shell.label}"]`).click();
  await $(".terminal-workspace-pane.active .xterm-screen").waitForDisplayed();
  await focusNativeApp();
}
export async function typeNativeCommand(command: string, marker: string) {
  await $(".terminal-workspace-pane.active .xterm-screen").click();
  await $(".terminal-workspace-pane.active .xterm-helper-textarea").addValue(command);
  await nativeKey("enter");
  await terminalContains(marker);
}
export async function selectTerminalWord(word: string) {
  const point = await browser.execute((expected) => {
    const row = Array.from(
      document.querySelectorAll<HTMLElement>(".terminal-workspace-pane.active .xterm-rows > div"),
    ).find((row) => row.textContent?.trim() === expected);
    if (!row) throw new Error("The copy fixture's output row is missing");
    const box = row.getBoundingClientRect();
    return {
      x: Math.round(box.left + 8),
      y: Math.round(box.top + box.height / 2),
      scale: devicePixelRatio,
    };
  }, word);
  await focusNativeApp();
  if (windows)
    powershell("double-click", String((await runtime()).appPid), [
      "-X",
      String(Math.round(point.x * point.scale)),
      "-Y",
      String(Math.round(point.y * point.scale)),
    ]);
  else if (mac) {
    const window = await browser.getWindowRect();
    execFileSync(
      "osascript",
      [
        "-e",
        `tell application "System Events" to click at {${Math.round(window.x + point.x)}, ${Math.round(window.y + point.y)}}`,
        "-e",
        `tell application "System Events" to click at {${Math.round(window.x + point.x)}, ${Math.round(window.y + point.y)}}`,
      ],
      { timeout: 10000 },
    );
  } else {
    const id = execFileSync("xdotool", ["getactivewindow"], { encoding: "utf8" }).trim();
    execFileSync(
      "xdotool",
      [
        "mousemove",
        "--window",
        id,
        String(point.x),
        String(point.y),
        "click",
        "--repeat",
        "2",
        "--delay",
        "80",
        "1",
      ],
      { timeout: 5000 },
    );
  }
  await expect($(".terminal-workspace-pane.active .xterm-screen")).toBeDisplayed();
}
export function windowsScale(percent?: number) {
  return Number(powershell("scale", percent ? String(percent) : ""));
}
