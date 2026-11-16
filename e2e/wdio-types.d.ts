import type { Browser as BrowserCommands } from "webdriverio";

declare global {
  namespace WebdriverIO {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Browser extends BrowserCommands {}
  }
}
