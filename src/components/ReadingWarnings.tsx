import { TriangleAlert } from "lucide-react";

export interface ReadingWarning {
  id: string;
  /** What could not be read, such as "Listening ports". */
  source: string;
  /** Short state beside the source: "Unavailable", or "Saved results shown". */
  state: string;
  /** The reason, usually the error the host or SSH reported. */
  detail: string;
  action?: {
    label: string;
    /** Names the read the button retries, because every button says "Retry". */
    accessibleName: string;
    onClick: () => void;
  };
}

/// One quiet row per failed or partial read: what is affected and its state on
/// one line, the reason beneath, and a compact action. Amber marks the row
/// without boxing every message in a warning border.
export function ReadingWarnings({ warnings }: { warnings: ReadingWarning[] }) {
  return (
    <ul className="reading-warnings">
      {warnings.map((warning) => (
        <li className="reading-warning" key={warning.id}>
          <TriangleAlert className="reading-warning-icon" size={14} aria-hidden="true" />
          <div className="reading-warning-body">
            <p className="reading-warning-title">
              <strong>{warning.source}</strong>
              <span>{warning.state}</span>
            </p>
            <p className="reading-warning-detail">{warning.detail}</p>
            {warning.action && (
              <button
                type="button"
                className="secondary-button reading-warning-action"
                aria-label={warning.action.accessibleName}
                onClick={warning.action.onClick}
              >
                {warning.action.label}
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
