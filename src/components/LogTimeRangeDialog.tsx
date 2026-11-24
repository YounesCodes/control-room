import { useState, type FormEvent } from "react";
import {
  localTimeInput,
  LOG_TIME_PRESETS,
  logTimeBounds,
  parseLocalTime,
  type LogTimeRange,
} from "../lib/log-time-range";
import { Modal } from "./Modal";

export function LogTimeRangeDialog({
  value,
  launchd,
  onClose,
  onApply,
}: {
  value: LogTimeRange | null;
  launchd: boolean;
  onClose: () => void;
  onApply: (value: LogTimeRange | null) => void;
}) {
  const [mode, setMode] = useState<LogTimeRange["mode"]>(value?.mode ?? "1h");
  const [initial] = useState(() => logTimeBounds(value ?? { mode: "1h" }));
  const [from, setFrom] = useState(() => localTimeInput(initial.start));
  const [to, setTo] = useState(() => localTimeInput(initial.end));
  const [error, setError] = useState<string | null>(null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function apply(event: FormEvent) {
    event.preventDefault();
    if (mode !== "custom") {
      onApply({ mode });
      return;
    }
    const start = parseLocalTime(from);
    const end = parseLocalTime(to);
    if (start === null || end === null) {
      setError("Enter a valid start and end date and time.");
    } else if (end <= start) {
      setError("End must be after start.");
    } else {
      onApply({ mode, bounds: { start, end } });
    }
  }

  return (
    <Modal title="Log time range" onClose={onClose} className="log-range-dialog">
      <form className="form-stack log-range-form" onSubmit={apply} noValidate>
        <div className="log-range-presets" role="group" aria-label="Time range presets">
          {[...LOG_TIME_PRESETS, { id: "custom", label: "Custom" } as const].map(
            ({ id, label }) => (
              <button
                key={id}
                className="secondary-button"
                type="button"
                aria-pressed={mode === id}
                onClick={() => {
                  setMode(id);
                  setError(null);
                }}
              >
                {label}
              </button>
            ),
          )}
        </div>
        {mode === "custom" && (
          <>
            <div className="log-range-fields">
              <label>
                <span>From</span>
                <input
                  type="datetime-local"
                  value={from}
                  onChange={(event) => {
                    setFrom(event.target.value);
                    setError(null);
                  }}
                  required
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "log-range-error" : undefined}
                />
              </label>
              <label>
                <span>To</span>
                <input
                  type="datetime-local"
                  value={to}
                  onChange={(event) => {
                    setTo(event.target.value);
                    setError(null);
                  }}
                  required
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "log-range-error" : undefined}
                />
              </label>
            </div>
            <p className="log-range-note">Your local time · {zone}</p>
          </>
        )}
        {error && (
          <p id="log-range-error" role="alert" className="inline-error">
            {error}
          </p>
        )}
        <p className="log-range-note">
          {launchd
            ? "Reads this service’s matching unified log entries."
            : "Shows up to 10,000 matching lines in a snapshot."}
        </p>
        <footer className="modal-actions">
          {value && (
            <button
              className="secondary-button log-range-clear"
              type="button"
              onClick={() => onApply(null)}
            >
              Clear range
            </button>
          )}
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit">
            Read logs
          </button>
        </footer>
      </form>
    </Modal>
  );
}
