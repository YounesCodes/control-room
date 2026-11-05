import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  HostBaseline,
  BaselineEntry,
  BaselineSection,
  BaselineSectionKind,
  BaselineSectionStatus,
} from "../../types";
import { entrySearchText, sectionLabel, statusHint, statusLabel } from "../../lib/host-baselines";

export function StatusChip({ status }: { status: BaselineSectionStatus }) {
  return (
    <span className={`baseline-status baseline-status-${status}`} title={statusHint(status)}>
      {statusLabel(status)}
    </span>
  );
}

/** Large sections render a window of matches rather than every row at once: a
 * package inventory can be thousands of rows, and the state view must stay
 * responsive while every entry remains findable through the filter. */
const VISIBLE_WINDOW = 150;

interface BaselineSectionListProps {
  baseline: HostBaseline;
  /** Which entry identity is being inspected, so the row shows its state. */
  selectedIdentity: string | null;
  onInspect: (section: BaselineSection, entry: BaselineEntry) => void;
}

// A capture is worth opening on its own, not only as one side of a diff, so
// every section that read something can be expanded to the entries it
// recorded. Selecting an entry opens the inspector beside the workspace.
export function BaselineSectionList({
  baseline,
  selectedIdentity,
  onInspect,
}: BaselineSectionListProps) {
  return (
    <div className="baseline-sections">
      {baseline.sections.map((section) => (
        <SectionView
          key={section.kind}
          section={section}
          selectedIdentity={selectedIdentity}
          onInspect={onInspect}
        />
      ))}
    </div>
  );
}

function sectionKind(section: BaselineSection): BaselineSectionKind {
  return section.kind as BaselineSectionKind;
}

function SectionView({
  section,
  selectedIdentity,
  onInspect,
}: {
  section: BaselineSection;
  selectedIdentity: string | null;
  onInspect: (section: BaselineSection, entry: BaselineEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("");
  const expandable = section.entries.length > 0;
  const needle = filter.trim().toLowerCase();
  const matching = needle
    ? section.entries.filter((entry) => entrySearchText(entry, needle))
    : section.entries;
  const visible = matching.slice(0, VISIBLE_WINDOW);

  return (
    <section className="baseline-section">
      <header>
        {expandable ? (
          <button
            className="baseline-section-toggle"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <h3>{sectionLabel(sectionKind(section))}</h3>
          </button>
        ) : (
          <h3>{sectionLabel(sectionKind(section))}</h3>
        )}
        <StatusChip status={section.status} />
        {section.kind !== "host" && (
          <span className="baseline-section-count">{section.entries.length} recorded</span>
        )}
      </header>
      {section.message && <p className="inline-warning">{section.message}</p>}
      {expanded && (
        <>
          {section.entries.length > 8 && (
            <input
              className="baseline-entry-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={`Filter ${section.entries.length} entries`}
              aria-label={`Filter ${sectionLabel(sectionKind(section))}`}
            />
          )}
          <ul className="baseline-entry-list">
            {visible.map((entry) => (
              <EntryRow
                key={entry.identity}
                entry={entry}
                section={section}
                selected={selectedIdentity === entry.identity}
                onInspect={onInspect}
              />
            ))}
          </ul>
          {!visible.length && <p className="baseline-section-count">No entry matches that text</p>}
          {matching.length > visible.length && (
            <p className="baseline-section-count">
              Showing {visible.length} of {matching.length} matching entries. Filter further to
              reach the rest.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function EntryRow({
  entry,
  section,
  selected,
  onInspect,
}: {
  entry: BaselineEntry;
  section: BaselineSection;
  selected: boolean;
  onInspect: (section: BaselineSection, entry: BaselineEntry) => void;
}) {
  return (
    <li>
      <button
        className={
          selected ? "baseline-entry-head baseline-entry-head-selected" : "baseline-entry-head"
        }
        type="button"
        onClick={() => onInspect(section, entry)}
      >
        <code>{entry.label}</code>
      </button>
      <dl className="baseline-entry-facts">
        {entry.facts.map((fact) => (
          <div key={fact.name}>
            <dt>{fact.name}</dt>
            <dd className="technical">{fact.value}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}
