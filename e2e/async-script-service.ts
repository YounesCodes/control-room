type Script = string | ((...args: any[]) => unknown);
type AsyncScriptBrowser = {
  executeAsync?: unknown;
  executeAsyncScript: (script: string, args: unknown[]) => Promise<unknown>;
  addCommand: (
    name: string,
    callback: (script: Script, ...args: any[]) => Promise<unknown>,
  ) => void;
};

// Tauri service 1.5 still uses WDIO 9's callback helper. WDIO 10 retains the
// underlying W3C async-script endpoint, which supplies the completion callback.
export function installAsyncScriptCommand(browser: AsyncScriptBrowser) {
  if (typeof browser.executeAsync === "function") return;
  browser.addCommand("executeAsync", (script, ...args) =>
    browser.executeAsyncScript(
      typeof script === "function"
        ? `return (${script.toString()}).apply(null, arguments);`
        : script,
      args,
    ),
  );
}

export default class AsyncScriptService {
  before(_capabilities: unknown, _specs: unknown, browser: AsyncScriptBrowser) {
    installAsyncScriptCommand(browser);
  }
}
