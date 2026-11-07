import { useState, type ReactNode } from "react";
import { AlertCircle, Camera, X } from "lucide-react";
import { Modal } from "../Modal";
import type { BaselineProgress, BaselineSectionKind } from "../../types";
import {
  SECTION_KINDS,
  sectionLabel,
  sectionShortLabel,
  statusLabel,
} from "../../lib/host-baselines";

interface BaselineCaptureDialogProps {
  connectionName: string;
  /** True while a capture is reading sections; progress carries real results. */
  running: boolean;
  progress: BaselineProgress[];
  /** What the user should know about elevation for this host, when it matters. */
  permissionNote: ReactNode;
  error?: string | null;
  onRequestCapture: (label: string, sections: BaselineSectionKind[]) => void;
  onStopCapture: () => void;
  onClose: () => void;
}

// A capture is a deliberate act, so it gets a focused dialog instead of a
// permanent form on the page: name it, choose what to read, start. Progress
// shows what actually finished — no invented percentages or times.
export function BaselineCaptureDialog({
  connectionName,
  running,
  progress,
  permissionNote,
  error,
  onRequestCapture,
  onStopCapture,
  onClose,
}: BaselineCaptureDialogProps) {
  const [label, setLabel] = useState("");
  const [chosen, setChosen] = useState<BaselineSectionKind[]>(SECTION_KINDS);
  const total = SECTION_KINDS.length;

  const toggle = (kind: BaselineSectionKind, wanted: boolean) => {
    setChosen((current) =>
      wanted
        ? SECTION_KINDS.filter((candidate) => candidate === kind || current.includes(candidate))
        : current.filter((candidate) => candidate !== kind),
    );
  };

  return (
    <Modal
      title={`Capture baseline of ${connectionName}`}
      onClose={running ? () => undefined : onClose}
      className="baseline-capture-modal"
    >
      <div className="baseline-capture-form">
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {!running && (
          <>
            <input
              className="baseline-capture-input"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Optional label, e.g. before upgrade"
              aria-label="Baseline label"
              maxLength={80}
              autoFocus
            />
            <fieldset className="baseline-capture-sections">
              <legend>Read{chosen.length < total ? ` (${chosen.length} of ${total})` : ""}</legend>
              {SECTION_KINDS.map((kind) => (
                <label key={kind} className="baseline-capture-section-choice">
                  <input
                    type="checkbox"
                    checked={chosen.includes(kind)}
                    onChange={(event) => toggle(kind, event.target.checked)}
                    aria-label={sectionLabel(kind)}
                  />
                  <span>{sectionShortLabel(kind)}</span>
                </label>
              ))}
            </fieldset>
            {permissionNote && (
              <p className="baseline-capture-note">
                <AlertCircle size={12} aria-hidden="true" />
                <span className="baseline-capture-note-text">{permissionNote}</span>
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={!chosen.length}
                onClick={() => {
                  onRequestCapture(label.trim() || "", chosen);
                }}
              >
                <Camera size={15} /> Start capture
              </button>
            </div>
          </>
        )}
        {running && (
          <>
            <ol className="baseline-progress" aria-live="polite">
              {progress.map((event) => (
                <li key={event.kind}>
                  <span>{sectionLabel(event.kind as BaselineSectionKind)}</span>
                  <span className={`baseline-status baseline-status-${event.status}`}>
                    {statusLabel(event.status)}
                  </span>
                </li>
              ))}
              <li className="baseline-progress-count">
                {progress.length} of {progress[0]?.total ?? total} sections read
              </li>
            </ol>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={onStopCapture}>
                <X size={15} /> Stop after this section
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
