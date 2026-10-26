import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Eraser, Redo2, RefreshCw, Trash2, Undo2 } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorState, LoadingState } from "./PanelState";
import { api, errorMessage } from "../lib/api";
import {
  MAX_SCRATCHPAD_CHARS,
  clearScratchpadDraft,
  readScratchpadDraft,
  registerScratchpadQuiesce,
  writeScratchpadDraft,
} from "../lib/scratchpad-draft";
import type { ScratchpadScope } from "../types";
type SaveStatus = "saved" | "unsaved" | "saving" | "error";
const EDIT_HISTORY_LIMIT = 100;

export function ScratchpadEditor({
  scope,
  ownerId,
  connectionId,
  onTextChange,
}: {
  scope: ScratchpadScope;
  ownerId: string;
  connectionId: string | null;
  onTextChange?: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [hasRecord, setHasRecord] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [, setHistoryVersion] = useState(0);
  const textRef = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const undoRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  const savedTextRef = useRef("");
  const pendingRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const activeSaveRef = useRef<Promise<void> | null>(null);
  const deletingRef = useRef(false);
  const mountedRef = useRef(true);
  textRef.current = text;

  useEffect(() => {
    mountedRef.current = true;
    let current = true;
    setLoaded(false);
    setLoadFailed(false);
    setError(null);
    void api
      .scratchpadNote(scope, ownerId, connectionId)
      .then((note) => {
        if (!current) return;
        const draft = readScratchpadDraft(scope, ownerId);
        const saved = note?.text ?? "";
        const initial = draft ?? saved;
        if (draft === saved) clearScratchpadDraft(scope, ownerId);
        savedTextRef.current = saved;
        textRef.current = initial;
        undoRef.current = [];
        redoRef.current = [];
        setHistoryVersion((current) => current + 1);
        setText(initial);
        setHasRecord(Boolean(note));
        setStatus(initial === saved ? "saved" : "unsaved");
        setLoaded(true);
      })
      .catch((caught) => {
        if (!current) return;
        const draft = readScratchpadDraft(scope, ownerId);
        if (draft !== null) {
          textRef.current = draft;
          setText(draft);
        }
        undoRef.current = [];
        redoRef.current = [];
        setHistoryVersion((current) => current + 1);
        setError(`Could not load the SQLite note: ${errorMessage(caught)}`);
        setLoadFailed(true);
        setStatus("error");
        setLoaded(true);
      });
    return () => {
      current = false;
      mountedRef.current = false;
    };
  }, [connectionId, loadVersion, ownerId, scope]);

  function setEditedText(nextText: string) {
    const currentText = textRef.current;
    if (nextText === currentText) return;
    undoRef.current.push(currentText);
    if (undoRef.current.length > EDIT_HISTORY_LIMIT) undoRef.current.shift();
    redoRef.current = [];
    textRef.current = nextText;
    setText(nextText);
    setHistoryVersion((current) => current + 1);
  }

  function restoreText(nextText: string) {
    textRef.current = nextText;
    setText(nextText);
    setHistoryVersion((current) => current + 1);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextText.length, nextText.length);
    });
  }

  function undoEdit() {
    const previousText = undoRef.current.pop();
    if (previousText === undefined) return;
    redoRef.current.push(textRef.current);
    restoreText(previousText);
  }

  function redoEdit() {
    const nextText = redoRef.current.pop();
    if (nextText === undefined) return;
    undoRef.current.push(textRef.current);
    restoreText(nextText);
  }

  async function runFlush() {
    if (savingRef.current || deletingRef.current) return;
    savingRef.current = true;
    while (pendingRef.current !== null && !deletingRef.current) {
      const snapshot = pendingRef.current;
      pendingRef.current = null;
      if (mountedRef.current) {
        setStatus("saving");
        setError(null);
      }
      try {
        await api.saveScratchpadNote({
          scope,
          ownerId,
          connectionId,
          text: snapshot,
        });
        savedTextRef.current = snapshot;
        if (mountedRef.current) setHasRecord(true);
      } catch (caught) {
        pendingRef.current = textRef.current;
        if (mountedRef.current) {
          setStatus("error");
          setError(`Autosave failed. Your local draft is still here: ${errorMessage(caught)}`);
        }
        break;
      }
    }
    savingRef.current = false;
    if (
      mountedRef.current &&
      !deletingRef.current &&
      pendingRef.current === null &&
      textRef.current === savedTextRef.current
    ) {
      clearScratchpadDraft(scope, ownerId);
      setStatus("saved");
    }
  }

  function flushLatest(): Promise<void> {
    if (activeSaveRef.current) return activeSaveRef.current;
    const save = runFlush().finally(() => {
      if (activeSaveRef.current === save) activeSaveRef.current = null;
    });
    activeSaveRef.current = save;
    return save;
  }

  async function quiesce() {
    deletingRef.current = true;
    pendingRef.current = null;
    await activeSaveRef.current;
    pendingRef.current = null;
  }

  useEffect(
    () =>
      registerScratchpadQuiesce(scope, ownerId, {
        quiesce,
        resume: () => {
          deletingRef.current = false;
          if (textRef.current !== savedTextRef.current) {
            pendingRef.current = textRef.current;
            void flushLatest();
          }
        },
      }),
    [ownerId, scope],
  );

  useEffect(() => {
    if (!loaded || loadFailed || text === savedTextRef.current) return;
    pendingRef.current = text;
    const draftStored = writeScratchpadDraft(scope, ownerId, text);
    setStatus("unsaved");
    setError(
      draftStored
        ? null
        : "The fallback draft could not be written. Keep this view open until autosave succeeds.",
    );
    const timer = window.setTimeout(() => void flushLatest(), 600);
    return () => window.clearTimeout(timer);
  }, [loadFailed, loaded, ownerId, scope, text]);

  // Reported through a ref so a compact caller can copy or paste the current
  // text without re-running the autosave effect on every callback identity.
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;
  useEffect(() => {
    onTextChangeRef.current?.(text);
  }, [text]);

  async function deleteNote() {
    await quiesce();
    setError(null);
    try {
      await api.deleteScratchpadNote(scope, ownerId, connectionId);
      savedTextRef.current = "";
      textRef.current = "";
      undoRef.current = [];
      redoRef.current = [];
      setHistoryVersion((current) => current + 1);
      clearScratchpadDraft(scope, ownerId);
      setText("");
      setHasRecord(false);
      setStatus("saved");
      setDeleteOpen(false);
    } catch (caught) {
      setStatus("error");
      setError(`Could not delete the note: ${errorMessage(caught)}`);
    } finally {
      deletingRef.current = false;
    }
  }

  if (!loaded) return <LoadingState label="Loading Scratchpad…" />;
  if (loadFailed && !text && error) {
    return (
      <ErrorState
        message={error}
        action={<button onClick={() => setLoadVersion((current) => current + 1)}>Retry</button>}
      />
    );
  }

  const scopeLabel =
    scope === "connection"
      ? "Connection note"
      : scope === "local"
        ? "Terminal note"
        : "Global note";
  const saveState = (
    <span className={`scratchpad-save-state scratchpad-save-${status}`} role="status">
      {status === "saving"
        ? "Saving…"
        : status === "unsaved"
          ? "Waiting to save"
          : status === "error"
            ? "Not saved"
            : "Saved locally"}
    </span>
  );
  return (
    <div className="scratchpad-editor scratchpad-editor-compact">
      <div className="scratchpad-editor-tools">
        {saveState}
        <div className="scratchpad-edit-actions" role="group" aria-label="Note editing">
          {(status === "error" || loadFailed) && (
            <button
              type="button"
              className="icon-button"
              aria-label={loadFailed ? "Retry load" : "Retry save"}
              title={loadFailed ? "Retry load" : "Retry save"}
              onClick={() => {
                if (loadFailed) setLoadVersion((current) => current + 1);
                else {
                  pendingRef.current = textRef.current;
                  void flushLatest();
                }
              }}
            >
              <RefreshCw size={13} />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
            disabled={!undoRef.current.length}
            onClick={undoEdit}
          >
            <Undo2 size={13} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Redo"
            title="Redo (Ctrl+Y)"
            disabled={!redoRef.current.length}
            onClick={redoEdit}
          >
            <Redo2 size={13} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Clear text"
            title="Clear text"
            disabled={!text}
            onClick={() => setEditedText("")}
          >
            <Eraser size={13} />
          </button>
          <button
            type="button"
            className="icon-button danger-text"
            aria-label="Delete note"
            title="Delete note"
            disabled={!hasRecord && !text}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <textarea
        ref={textareaRef}
        aria-label={scopeLabel}
        value={text}
        maxLength={MAX_SCRATCHPAD_CHARS}
        autoFocus
        onChange={(event) => setEditedText(event.target.value)}
        onKeyDown={(event) => {
          if (!(event.ctrlKey || event.metaKey)) return;
          const key = event.key.toLowerCase();
          if (key === "z") {
            event.preventDefault();
            if (event.shiftKey) redoEdit();
            else undoEdit();
          } else if (key === "y") {
            event.preventDefault();
            redoEdit();
          }
        }}
        placeholder={scope === "global" ? "Notes for every terminal…" : "Notes for this terminal…"}
        spellCheck={false}
      />
      {error && <p className="inline-error">{error}</p>}
      {deleteOpen &&
        createPortal(
          <ConfirmDialog
            title={`Delete ${scopeLabel.toLowerCase()}`}
            message="Delete this local note and its fallback draft? This cannot be undone."
            confirmLabel="Delete note"
            danger
            onConfirm={() => void deleteNote()}
            onClose={() => setDeleteOpen(false)}
          />,
          document.body,
        )}
    </div>
  );
}
