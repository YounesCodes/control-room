import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { runtime, terminalContains } from "./helpers";
import {
  focusNativeApp,
  nativeKey,
  openNativeShell,
  readClipboard,
  selectTerminalWord,
  typeNativeCommand,
  writeClipboard,
} from "./native-input";

describe("Native OS clipboard and shell control keys", () => {
  let originalClipboard = "";
  beforeEach(() => {
    originalClipboard = readClipboard();
  });
  afterEach(() => {
    writeClipboard(originalClipboard);
  });

  it("copies a terminal selection into the actual OS clipboard", async () => {
    await openNativeShell();
    await typeNativeCommand("echo NATIVE_COPY_TOKEN", "NATIVE_COPY_TOKEN");
    await selectTerminalWord("NATIVE_COPY_TOKEN");
    await nativeKey("primary+shift+c");
    await browser.waitUntil(async () => readClipboard() === "NATIVE_COPY_TOKEN", {
      timeoutMsg: "Native copy did not update the OS clipboard",
    });
  });

  it("pastes multiline Unicode with real bracketed-paste bytes through the OS clipboard", async () => {
    await openNativeShell();
    const before = (await runtime()).sessionIds;
    const program =
      "process.stdin.setRawMode(true);process.stdout.write(String.fromCharCode(27)+'[?2004h\\r\\nPASTE_READY\\r\\n');let data=Buffer.alloc(0);process.stdin.on('data',function(chunk){data=Buffer.concat([data,chunk]);if(data.includes(Buffer.from([27,91,50,48,49,126]))){process.stdout.write(String.fromCharCode(27)+'[?2004l\\r\\nNATIVE_BYTES_'+data.toString('base64')+'\\r\\n');process.stdin.setRawMode(false);process.exit(0)}})";
    await typeNativeCommand(`node -e "${program}"`, "PASTE_READY");
    const payload = "first èé\nsecond 日本語";
    writeClipboard(payload);
    expect(readClipboard()).toBe(payload);
    await focusNativeApp();
    await nativeKey("primary+shift+v");
    const expected = Buffer.from(
      "\x1b[200~" + payload.replace(/\r?\n/g, "\r") + "\x1b[201~",
    ).toString("base64");
    await terminalContains("NATIVE_BYTES_" + expected);
    expect((await runtime()).sessionIds).toEqual(before);
  });

  for (const [key, byte] of [
    ["c", "03"],
    ["w", "17"],
  ]) {
    it(`forwards shell Ctrl+${key.toUpperCase()} without opening app actions or closing its workspace`, async () => {
      await openNativeShell();
      const before = (await runtime()).sessionIds;
      const program =
        "process.stdin.setRawMode(true);process.stdout.write('\\r\\nCONTROL_KEY_READY\\r\\n');process.stdin.once('data',function(data){process.stdin.setRawMode(false);process.stdout.write('\\r\\nNATIVE_KEY_'+data.toString('hex')+'\\r\\n');process.exit(0)})";
      await typeNativeCommand(`node -e "${program}"`, "CONTROL_KEY_READY");
      await nativeKey("ctrl+" + key);
      await terminalContains("NATIVE_KEY_" + byte);
      expect((await runtime()).sessionIds).toEqual(before);
      await expect($("[aria-label='Command palette']")).not.toExist();
      await expect($("[role=dialog]")).not.toExist();
    });
  }
});
