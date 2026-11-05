import { useCallback, useLayoutEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, ChevronsRight, Flag, Pin } from "lucide-react";
import type { HostBaselineSummary } from "../../types";
import { baselineTitle, coverageText } from "../../lib/host-baselines";

interface BaselineTimelineProps {
  /** Newest first, exactly as `sortBaselines` returns it. */
  baselines: HostBaselineSummary[];
  selectedId: string | null;
  referenceId: string | null;
  onSelect: (id: string) => void;
  onLatest: () => void;
  onReference: () => void;
}

// One chronological ribbon: oldest on the left, newest on the right. A capture
// is what it recorded at the moment it ran, so the ribbon only ever shows
// recorded observations — never a line that implies the host was watched
// in between.
export function BaselineTimeline({
  baselines,
  selectedId,
  referenceId,
  onSelect,
  onLatest,
  onReference,
}: BaselineTimelineProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const oldestFirst = [...baselines].reverse();

  // The selection indicator glides to the selected node from wherever it was,
  // and settles instantly when the user asked for reduced motion. The node
  // itself snaps into view so the selection is never clipped by the ribbon's
  // scrolling.
  useLayoutEffect(() => {
    const indicator = indicatorRef.current;
    const node = selectedRef.current;
    if (!indicator || !node) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    indicator.style.transition = reduced ? "none" : "";
    indicator.style.width = `${node.offsetWidth}px`;
    indicator.style.height = `${node.offsetHeight}px`;
    indicator.style.transform = `translateX(${node.offsetLeft}px) translateY(${node.offsetTop - 2}px)`;
    indicator.style.opacity = "1";
    node.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [selectedId, baselines]);

  const revealNode = (id: string) => {
    requestAnimationFrame(() => {
      document
        .getElementById(`baseline-node-${id}`)
        // jsdom has no scrolling; the guard keeps environments without layout
        // from throwing on reveal.
        ?.scrollIntoView?.({ block: "nearest", inline: "center" });
    });
  };

  // The ribbon keeps its own keyboard mode: Left and Right hold chronology,
  // Home and End jump to the record ends. Every step selects the node, so the
  // rest of the pane follows as one coordinated interaction.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        if (event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const target = event.key === "Home" ? oldestFirst[0] : baselines[0];
        if (target) {
          onSelect(target.id);
          document.getElementById(`baseline-node-${target.id}`)?.focus();
          revealNode(target.id);
        }
        return;
      }
      const index = oldestFirst.findIndex((baseline) => baseline.id === selectedId);
      if (index === -1) return;
      event.preventDefault();
      const next = event.key === "ArrowLeft" ? index - 1 : index + 1;
      const target = oldestFirst[next];
      if (target) {
        onSelect(target.id);
        document.getElementById(`baseline-node-${target.id}`)?.focus();
        revealNode(target.id);
      }
    },
    [baselines, oldestFirst, onSelect, selectedId],
  );

  if (!oldestFirst.length) return null;
  const referenceExists = baselines.some((baseline) => baseline.id === referenceId);
  return (
    <div className="baseline-timeline-wrap">
      <div className="baseline-timeline-side">
        <button
          type="button"
          className="icon-button"
          aria-label="Previous capture"
          disabled={!oldestFirst[oldestFirst.findIndex((item) => item.id === selectedId) - 1]}
          onClick={() => {
            const item = oldestFirst[oldestFirst.findIndex((item) => item.id === selectedId) - 1];
            if (item) onSelect(item.id);
          }}
        >
          <ChevronLeft size={14} />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="Jump to latest capture"
          title="Select the latest saved capture"
          onClick={onLatest}
        >
          <ChevronsRight size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Next capture"
          disabled={selectedId === baselines[0]?.id}
          onClick={() => {
            const item = oldestFirst[oldestFirst.findIndex((item) => item.id === selectedId) + 1];
            if (item) onSelect(item.id);
          }}
        >
          <ChevronRight size={14} />
        </button>
        {referenceExists && (
          <button
            className="icon-button"
            type="button"
            aria-label="Jump to reference capture"
            title="Select the capture marked as reference"
            onClick={onReference}
          >
            <Flag size={14} />
          </button>
        )}
      </div>
      <div
        className="baseline-timeline"
        role="group"
        aria-label="Capture history"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div className="baseline-timeline-selection" ref={indicatorRef} aria-hidden="true" />
        {oldestFirst.map((baseline, index) => {
          const isSelected = baseline.id === selectedId;
          return (
            <button
              key={baseline.id}
              id={`baseline-node-${baseline.id}`}
              className={isSelected ? "baseline-node baseline-node-selected" : "baseline-node"}
              type="button"
              ref={isSelected ? selectedRef : undefined}
              tabIndex={isSelected ? 0 : -1}
              aria-description={nodeDescription(baseline, baseline.id === referenceId)}
              aria-current={isSelected ? "true" : undefined}
              title={nodeDescription(baseline, baseline.id === referenceId)}
              onClick={() => {
                onSelect(baseline.id);
                revealNode(baseline.id);
              }}
            >
              <span className="baseline-node-date">{nodeDate(baseline.capturedAt)}</span>
              <span className="baseline-node-title">{baselineTitle(baseline)}</span>
              <span className="baseline-node-meta">
                <span className="baseline-node-count">
                  {baseline.changesSincePrevious === null
                    ? index === 0
                      ? "First capture"
                      : "Not comparable"
                    : `${baseline.changesSincePrevious} changed`}
                </span>
                <span>{coverageText(baseline)}</span>
                {baseline.routineSincePrevious != null && baseline.routineSincePrevious > 0 && (
                  <span>{baseline.routineSincePrevious} routine</span>
                )}
                {baseline.pinned && <Pin size={11} aria-hidden="true" />}
                {baseline.id === referenceId && (
                  <Flag size={11} aria-hidden="true" className="baseline-node-ref" />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function nodeDescription(baseline: HostBaselineSummary, isReference: boolean): string {
  const changes =
    baseline.changesSincePrevious === null
      ? "No comparable earlier capture"
      : `${baseline.changesSincePrevious} meaningful change${
          baseline.changesSincePrevious === 1 ? "" : "s"
        } since the previous capture`;
  const routine =
    baseline.routineSincePrevious !== null && baseline.routineSincePrevious > 0
      ? ` · ${baseline.routineSincePrevious} routine hidden`
      : "";
  const flags = [baseline.pinned ? "pinned" : "", isReference ? "reference" : ""]
    .filter(Boolean)
    .join(" · ");
  const flagged = flags ? ` · ${flags}` : "";
  return `${baselineTitle(baseline)} · ${coverageText(baseline)} · ${changes}${routine}${flagged}`;
}

function nodeDate(capturedAt: string): string {
  const captured = new Date(capturedAt);
  if (Number.isNaN(captured.getTime())) return capturedAt;
  const now = new Date();
  const sameYear = captured.getFullYear() === now.getFullYear();
  return captured.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
