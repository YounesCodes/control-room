// macOS WebKit follows Safari's default and moves Tab focus only between text
// fields. Option+Tab reaches every focusable control, like Tab elsewhere.
const macWebKit =
  typeof navigator !== "undefined" &&
  navigator.platform.startsWith("Mac") &&
  !/Chrome|Chromium|Firefox/.test(navigator.userAgent);

export const tabKey = macWebKit ? "{Alt>}{Tab}{/Alt}" : "{Tab}";
export const shiftTabKey = macWebKit
  ? "{Alt>}{Shift>}{Tab}{/Shift}{/Alt}"
  : "{Shift>}{Tab}{/Shift}";
