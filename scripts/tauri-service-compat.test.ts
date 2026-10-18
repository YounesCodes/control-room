import { describe, expect, it, vi } from "vitest";
import AsyncScriptService, { installAsyncScriptCommand } from "../e2e/async-script-service";

function fixture() {
  const browser = {
    executeAsync: undefined as any,
    executeAsyncScript: vi.fn(
      async (script: string, args: unknown[]) =>
        new Promise((resolve) => new Function(script)(...args, resolve)),
    ),
    addCommand: vi.fn((name: string, callback: any) => {
      expect(name).toBe("executeAsync");
      browser.executeAsync = callback;
    }),
  };
  return browser;
}

describe("Tauri service compatibility with WDIO 10", () => {
  it("preserves the completion callback for function and string scripts", async () => {
    const browser = fixture();
    new AsyncScriptService().before({}, [], browser);
    expect(await browser.executeAsync((value: string, done: any) => done(value), "function")).toBe(
      "function",
    );
    expect(await browser.executeAsync("arguments[1](arguments[0]);", "string")).toBe("string");
  });

  it("keeps a registered command across repeated setup and forwards protocol failures", async () => {
    const browser = fixture();
    installAsyncScriptCommand(browser);
    installAsyncScriptCommand(browser);
    expect(browser.addCommand).toHaveBeenCalledOnce();
    browser.executeAsyncScript.mockRejectedValueOnce(new Error("session ended"));
    await expect(browser.executeAsync("", "value")).rejects.toThrow("session ended");
  });
});
