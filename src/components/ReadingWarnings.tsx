import { TriangleAlert } from "lucide-react";

export interface ReadingWarning {
  id: string;
  source: string;
  state: string;
  detail: string;
  action?: {
    label: string;
    accessibleName: string;
    onClick: () => void;
  };
}

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
