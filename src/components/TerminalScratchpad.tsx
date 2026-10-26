import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ClipboardCopy, Globe2, SquareTerminal, TerminalSquare } from "lucide-react";
import { ScratchpadEditor } from "./ScratchpadEditor";
import type { ScratchpadScope } from "../types";

/**
 * The Scratchpad popover anchored to the terminal action strip.
 *
 * It answers "let me jot something down or pull a note back into this
 * terminal" without leaving the terminal view, in normal mode and Focus Mode
 * alike. The note follows the active terminal: a local terminal workspace
 * owns a note of its own, a remote terminal uses its connection's note, and
 * the global note stays one switch away. The shared editor owns autosave and
 * recovery drafts.
 */
export function TerminalScratchpad({
  terminalScope,
  ownerId,
  ownerLabel,
  canPaste,
  onPaste,
  onClose,
  closing,
  style,
}: {
  /** What the active terminal is: a local workspace or a Saved Connection. */
  terminalScope: Extract<ScratchpadScope, "local" | "connection">;
  /** The workspace UUID for a local terminal, the connection UUID otherwise. */
  ownerId: string;
  /** Names the terminal's owner in the switch and its accessible labels. */
  ownerLabel: string;
  /** False while the terminal has no live session to receive pasted text. */
  canPaste: boolean;
  /** Receives the note text; the caller owns writing it to the terminal. */
  onPaste: (text: string) => void;
  onClose: () => void;
  /** True while the popover plays its closing transition before unmounting. */
  closing?: boolean;
  style?: CSSProperties;
}) {
  const [selection, setSelection] = useState<"terminal" | "global">("terminal");
  const scope = selection === "global" ? "global" : terminalScope;
  const [text, setText] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const terminalLabel = terminalScope === "local" ? "Terminal" : "Connection";
  const terminalAriaLabel =
    terminalScope === "local"
      ? `Terminal note for ${ownerLabel}`
      : `Connection note for ${ownerLabel}`;
  const scopedOwnerId = scope === "global" ? "global" : ownerId;
  useLayoutEffect(() => setText(""), [scope, scopedOwnerId]);

  useEffect(() => {
    // Clicks outside the popover close it, except on its own trigger button,
    // which the caller marks so a toggle click does not reopen immediately.
    const closeOutside = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (rootRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-scratchpad-trigger]")) return;
      if (target instanceof Element && target.closest(".modal-backdrop")) return;
      onCloseRef.current();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  useEffect(() => {
    // The editor owns the initial focus through autoFocus; this repeats it
    // when a quick reopen cancels the closing transition, since the popover
    // element stayed mounted and autoFocus never runs a second time.
    if (closing) return;
    rootRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, [closing]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (
      event.key === "Escape" &&
      event.target instanceof Element &&
      event.target.closest('[role="dialog"]') === event.currentTarget
    ) {
      event.preventDefault();
      onCloseRef.current();
    }
  }

  async function copyNote() {
    if (!text) return;
    await navigator.clipboard.writeText(text);
  }

  return (
    <div
      ref={rootRef}
      className="scratchpad-popover"
      style={style}
      role="dialog"
      aria-label={closing ? undefined : "Scratchpad"}
      aria-hidden={closing || undefined}
      inert={closing || undefined}
      data-closing={closing || undefined}
      data-app-popover=""
      onKeyDown={onKeyDown}
    >
      <div className="scratchpad-popover-scope" role="group" aria-label="Scratchpad scope">
        <button
          type="button"
          aria-pressed={scope === terminalScope}
          aria-label={terminalAriaLabel}
          title={ownerLabel}
          onClick={() => setSelection("terminal")}
        >
          {terminalScope === "local" ? (
            <SquareTerminal size={14} aria-hidden="true" />
          ) : (
            <TerminalSquare size={14} aria-hidden="true" />
          )}
          <span>{terminalLabel}</span>
        </button>
        <button
          type="button"
          aria-pressed={scope === "global"}
          aria-label="Global note for all connections"
          onClick={() => setSelection("global")}
        >
          <Globe2 size={14} aria-hidden="true" />
          <span>Global</span>
        </button>
      </div>
      <ScratchpadEditor
        key={`${scope}:${scopedOwnerId}`}
        scope={scope}
        ownerId={scopedOwnerId}
        connectionId={scope === "connection" ? ownerId : null}
        onTextChange={setText}
      />
      <div className="scratchpad-popover-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={!text}
          onClick={() => void copyNote()}
          title="Copy the note to the clipboard"
        >
          <ClipboardCopy size={14} /> Copy
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={!text || !canPaste}
          onClick={() => onPaste(text)}
          title="Insert the note into the terminal without running it"
        >
          <TerminalSquare size={14} /> Paste into terminal
        </button>
      </div>
    </div>
  );
}
