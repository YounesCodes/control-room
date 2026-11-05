import { useState } from "react";
import { formatOffsetClock, upperBound, type ReplayEvent } from "../../lib/boot-replay";
import { categoryLabel } from "./BootTimeline";

const CATEGORY_FILTERS = ["all", "error", "warning", "milestone", "unit"] as const;
const ROW_BATCH = 100;

/**
 * The opt-in journal lane under the theater: every loaded record in the
 * window, searchable and filterable, time-aligned with the same playhead.
 * A row seeks there and opens the same inspector a marker would; the row at
 * the playhead is marked so the two views never disagree about "now".
 */
export function BootJournalLane({
  inWindowEvents,
  untimedEvents,
  positionUs,
  hasMore,
  loadingMore,
  onLoadMore,
  onSeek,
  onSelectEvent,
}: {
  inWindowEvents: ReplayEvent[];
  untimedEvents: ReplayEvent[];
  positionUs: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSeek: (positionUs: number) => void;
  onSelectEvent: (event: ReplayEvent) => void;
}) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORY_FILTERS)[number]>("all");
  const [rowCap, setRowCap] = useState(ROW_BATCH);

  const needle = search.trim().toLowerCase();
  const rows = inWindowEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => {
      if (category !== "all" && event.category !== category) return false;
      if (!needle) return true;
      return (
        event.message.toLowerCase().includes(needle) ||
        (event.unit?.toLowerCase().includes(needle) ?? false) ||
        (event.source?.toLowerCase().includes(needle) ?? false)
      );
    });
  const atPlayheadIndex = upperBound(inWindowEvents, positionUs) - 1;
  const visibleRows = rows.slice(0, rowCap);

  return (
    <details className="boot-journal-lane">
      <summary>
        <span>Show loaded events</span>
        <span>
          {inWindowEvents.length} in window · {untimedEvents.length} without a boot-relative offset
        </span>
      </summary>
      <div className="boot-journal-controls">
        <input
          type="search"
          aria-label="Search loaded events"
          placeholder="Search events"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setRowCap(ROW_BATCH);
          }}
        />
        <label>
          <span>Category</span>
          <select
            aria-label="Filter by category"
            value={category}
            onChange={(event) => {
              setCategory(event.target.value as (typeof CATEGORY_FILTERS)[number]);
              setRowCap(ROW_BATCH);
            }}
          >
            {CATEGORY_FILTERS.map((option) => (
              <option key={option} value={option}>
                {option === "all" ? "All" : categoryLabel(option)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {visibleRows.length ? (
        <ol className="boot-journal-rows">
          {visibleRows.map(({ event, index }) => {
            const atPlayhead = index === atPlayheadIndex;
            return (
              <li key={event.id}>
                <button
                  type="button"
                  className={atPlayhead ? "at-playhead" : ""}
                  aria-current={atPlayhead ? "true" : undefined}
                  onClick={() => {
                    onSeek(event.offsetUs ?? positionUs);
                    onSelectEvent(event);
                  }}
                >
                  <time>
                    {event.offsetUs !== null
                      ? `T+${formatOffsetClock(event.offsetUs)}`
                      : "no offset"}
                  </time>
                  <span className="boot-journal-category">{categoryLabel(event.category)}</span>
                  <span className="boot-journal-source">{event.unit ?? event.source ?? ""}</span>
                  <span className="boot-journal-message">{event.message}</span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="boot-empty">No loaded events match this search in the window.</p>
      )}
      {rows.length > rowCap && (
        <button
          type="button"
          className="secondary-button"
          onClick={() => setRowCap(rowCap + ROW_BATCH)}
        >
          Show {Math.min(ROW_BATCH, rows.length - rowCap)} more rows
        </button>
      )}
      {untimedEvents.length > 0 && (
        <p className="boot-observation">
          {untimedEvents.length} loaded record{untimedEvents.length === 1 ? "" : "s"} without a
          boot-relative offset stay off the timeline; the journal could not place them in the boot.
        </p>
      )}
      {hasMore ? (
        <button
          type="button"
          className="secondary-button boot-journal-load"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? "Loading…" : "Load more retained events"}
        </button>
      ) : (
        <p className="boot-observation">
          Everything retained for these filters has been loaded in this session.
        </p>
      )}
    </details>
  );
}
