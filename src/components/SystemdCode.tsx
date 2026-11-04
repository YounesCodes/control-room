import { useMemo } from "react";
import { systemdCodeTokens } from "../lib/systemd-code";

export function SystemdCode({
  text,
  label,
  command = false,
}: {
  text: string;
  label: string;
  command?: boolean;
}) {
  const tokens = useMemo(() => systemdCodeTokens(text), [text]);
  const metadata = command && text.trimStart().startsWith("{");
  return (
    <pre
      className="systemd-code"
      tabIndex={0}
      aria-label={label}
      onCopy={(event) => {
        const selection = event.currentTarget.ownerDocument.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
        const range = selection.getRangeAt(0);
        if (!event.currentTarget.contains(range.commonAncestorContainer)) return;
        // Visual metadata breaks must not become extra bytes in copied commands.
        event.clipboardData.setData("text/plain", range.cloneContents().textContent ?? "");
        event.preventDefault();
      }}
    >
      <code>
        {tokens.map((token, index) => (
          <span
            key={index}
            className={
              "systemd-code-" +
              token.kind +
              (metadata && token.text === ";" ? " systemd-code-break" : "")
            }
          >
            {token.text}
          </span>
        ))}
      </code>
    </pre>
  );
}
