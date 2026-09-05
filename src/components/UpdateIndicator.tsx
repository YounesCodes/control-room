import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownToLine, RotateCcw } from "lucide-react";
import {
  canOpenUpdateDetails,
  downloadPercent,
  updateIndicatorAccessibleName,
  updateIndicatorLabel,
  type AppUpdateState,
} from "../lib/app-update";
import { ReleaseNotes } from "./ReleaseNotes";
import { releaseNotesAreEmpty } from "../lib/release-notes";

interface UpdateIndicatorProps {
  state: AppUpdateState;
  onDownload: () => void;
  onRestart: () => void;
}

/**
 * The titlebar update control, immediately left of Settings.
 *
 * Nothing renders while Control Room is current, so the titlebar of an
 * up-to-date app is exactly what it was before this feature existed. The
 * control is a normal button and carries no `data-tauri-drag-region`, so
 * clicking it never starts a window drag.
 */
export function UpdateIndicator({ state, onDownload, onRestart }: UpdateIndicatorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const label = updateIndicatorLabel(state);

  useEffect(() => {
    if (!open) return;
    function pointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", pointerDown);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("mousedown", pointerDown);
      document.removeEventListener("keydown", keydown);
    };
  }, [open]);

  // An update that finishes downloading while the panel is open leaves the
  // panel describing a step that has passed, so it closes itself.
  useEffect(() => {
    if (state.status === "installing") setOpen(false);
  }, [state.status]);

  if (label === null) return null;

  const info = "info" in state ? state.info : null;
  const percent =
    state.status === "downloading" ? downloadPercent(state.downloaded, state.total) : null;
  const busy = state.status === "downloading" || state.status === "installing";

  return (
    <div className="update-indicator" ref={containerRef}>
      <button
        className={open ? "update-indicator-button active" : "update-indicator-button"}
        type="button"
        onClick={() => canOpenUpdateDetails(state) && setOpen((current) => !current)}
        aria-label={updateIndicatorAccessibleName(state) ?? label}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        title={label}
      >
        <span
          className="update-indicator-dot"
          aria-hidden="true"
          data-state={state.status === "downloaded" ? "ready" : "pending"}
        />
        <span className="update-indicator-label">{label}</span>
      </button>

      {/* Progress semantics live on a dedicated node so the button keeps a
          stable accessible name while the percentage moves. */}
      {state.status === "downloading" && (
        <span
          className="sr-only"
          role="progressbar"
          aria-label={`Downloading Control Room ${info?.version ?? ""}`}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percent === null ? {} : { "aria-valuenow": percent })}
          aria-valuetext={percent === null ? "Downloading, size unknown" : `${percent} percent`}
        />
      )}

      {open && info && (
        <div
          className="update-panel"
          id={panelId}
          role="dialog"
          aria-label={`Control Room ${info.version}`}
        >
          <header className="update-panel-header">
            <h3>Control Room v{info.version}</h3>
            <p>You have v{info.currentVersion}</p>
          </header>

          {state.status === "failed" ? (
            <p className="update-panel-error" role="status">
              {state.failure.kind === "signature"
                ? "The update signature did not verify, so it was not installed."
                : state.failure.message}
            </p>
          ) : releaseNotesAreEmpty(info.notes) ? (
            <p className="update-panel-empty">This release has no notes.</p>
          ) : (
            <div className="update-panel-notes">
              <h4 className="update-panel-notes-title">What&rsquo;s new</h4>
              <ReleaseNotes notes={info.notes} />
            </div>
          )}

          <footer className="update-panel-actions">
            <button className="secondary-button" type="button" onClick={() => setOpen(false)}>
              Later
            </button>
            {state.status === "downloaded" ? (
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  setOpen(false);
                  onRestart();
                }}
              >
                <RotateCcw size={15} /> Restart to update
              </button>
            ) : (
              <button className="primary-button" type="button" onClick={onDownload} disabled={busy}>
                <ArrowDownToLine size={15} />
                {state.status === "downloading"
                  ? updateIndicatorLabel(state)
                  : state.status === "failed"
                    ? "Try again"
                    : "Download update"}
              </button>
            )}
          </footer>
        </div>
      )}
    </div>
  );
}
