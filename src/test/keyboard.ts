// macOS WebKit moves Tab focus only between text fields; Option+Tab reaches every control.
const macWebKit =
  typeof navigator !== "undefined" &&
  navigator.platform.startsWith("Mac") &&
  !/Chrome|Chromium|Firefox/.test(navigator.userAgent);

export const tabKey = macWebKit ? "{Alt>}{Tab}{/Alt}" : "{Tab}";
export const shiftTabKey = macWebKit
  ? "{Alt>}{Shift>}{Tab}{/Shift}{/Alt}"
  : "{Shift>}{Tab}{/Shift}";

export const forceSelectionModifier =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Mac") ? "Alt" : "Shift";
