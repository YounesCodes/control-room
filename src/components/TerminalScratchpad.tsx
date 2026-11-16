import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Copy, Globe2, SquareTerminal, TerminalSquare } from "lucide-react";
import { ScratchpadEditor } from "./ScratchpadEditor";
import type { ScratchpadScope } from "../types";

type NoteSelection = "terminal" | "global";

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
  terminalScope: Extract<ScratchpadScope, "local" | "connection">;
  ownerId: string;
  ownerLabel: string;
  canPaste: boolean;
  onPaste: (text: string) => void;
  onClose: () => void;
  closing?: boolean;
  style?: CSSProperties;
}) {
  const [selection, setSelection] = useState<NoteSelection>("terminal");
  const [texts, setTexts] = useState<Record<NoteSelection, string>>({ terminal: "", global: "" });
  const [wasClosing, setWasClosing] = useState(Boolean(closing));
  if (wasClosing !== Boolean(closing)) {
    setWasClosing(Boolean(closing));
    if (!closing) setSelection("terminal");
  }
  const text = texts[selection];
  const rootRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<Record<NoteSelection, HTMLDivElement | null>>({
    terminal: null,
    global: null,
  });
  const shownSelection = useRef(selection);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const terminalLabel = terminalScope === "local" ? "Terminal" : "Connection";
  const terminalAriaLabel =
    terminalScope === "local"
      ? `Terminal note for ${ownerLabel}`
      : `Connection note for ${ownerLabel}`;
  const terminalNoteKey = `${terminalScope}:${ownerId}`;
  useLayoutEffect(() => setTexts((current) => ({ ...current, terminal: "" })), [terminalNoteKey]);

  useLayoutEffect(() => {
    if (shownSelection.current === selection) return;
    shownSelection.current = selection;
    const note = notesRef.current[selection];
    note?.querySelector("textarea")?.focus();
    if (!note?.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const styles = getComputedStyle(document.documentElement);
    const time = /^(\d*\.?\d+)(ms|s)$/.exec(styles.getPropertyValue("--motion-med").trim());
    const animation = note.animate([{ opacity: 0.35 }, { opacity: 1 }], {
      duration: time ? Number(time[1]) * (time[2] === "s" ? 1000 : 1) : 160,
      easing: styles.getPropertyValue("--ease").trim() || "ease-out",
    });
    return () => animation.cancel();
  }, [selection]);

  useEffect(() => {
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
    // autoFocus does not run again when a reopen cancels the closing transition.
    if (closing) return;
    notesRef.current[shownSelection.current]?.querySelector("textarea")?.focus();
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
          aria-pressed={selection === "terminal"}
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
          aria-pressed={selection === "global"}
          aria-label="Global note for all connections"
          onClick={() => setSelection("global")}
        >
          <Globe2 size={14} aria-hidden="true" />
          <span>Global</span>
        </button>
      </div>
      <div
        ref={(node) => {
          notesRef.current.terminal = node;
        }}
        className="scratchpad-popover-note"
        hidden={selection !== "terminal"}
      >
        <ScratchpadEditor
          key={terminalNoteKey}
          scope={terminalScope}
          ownerId={ownerId}
          connectionId={terminalScope === "connection" ? ownerId : null}
          onTextChange={(terminalText) =>
            setTexts((current) => ({ ...current, terminal: terminalText }))
          }
        />
      </div>
      <div
        ref={(node) => {
          notesRef.current.global = node;
        }}
        className="scratchpad-popover-note"
        hidden={selection !== "global"}
      >
        <ScratchpadEditor
          scope="global"
          ownerId="global"
          connectionId={null}
          onTextChange={(globalText) => setTexts((current) => ({ ...current, global: globalText }))}
        />
      </div>
      <div className="scratchpad-popover-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={!text}
          onClick={() => void copyNote()}
        >
          <Copy size={14} /> Copy
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={!text || !canPaste}
          onClick={() => onPaste(text)}
        >
          <TerminalSquare size={14} /> Paste into terminal
        </button>
      </div>
    </div>
  );
}
