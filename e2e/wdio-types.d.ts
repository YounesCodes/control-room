import type { Browser as BrowserCommands } from "webdriverio";

declare global {
  namespace WebdriverIO {
    // WDIO's global Browser starts empty; this imports its command methods.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Browser extends BrowserCommands {}
  }
}
