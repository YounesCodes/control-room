import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Camera, Pencil, Pin, PinOff, RefreshCw, Trash2, X } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { BaselineComparisonView } from "../components/baselines/BaselineComparisonView";
import { BaselineSectionList } from "../components/baselines/BaselineSectionList";
import { api, errorMessage } from "../lib/api";
import {
  LIVE_COMPARISON_ID,
  SECTION_KINDS,
  formatCapturedAt,
  orderForComparison,
  sectionLabel,
  sectionShortLabel,
  baselineTitle,
  sortBaselines,
  statusLabel,
} from "../lib/host-baselines";
import type {
  HostBaseline,
  HostBaselineSummary,
  SavedConnection,
  BaselineComparison,
  BaselineProgress,
  BaselineSectionKind,
} from "../types";

interface BaselinesPaneProps {
  connection: SavedConnection;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

// Capture only ever starts from the button below. There is no timer here and no
// automatic recapture: a baseline exists because someone asked for one.
export function BaselinesPane({ connection, selectedId, onSelect }: BaselinesPaneProps) {
  const [baselines, setBaselines] = useState<HostBaselineSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [chosenSections, setChosenSections] = useState<BaselineSectionKind[]>(SECTION_KINDS);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [progress, setProgress] = useState<BaselineProgress[]>([]);
  const [detail, setDetail] = useState<HostBaseline | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [compareWithId, setCompareWithId] = useState("");
  const [comparison, setComparison] = useState<BaselineComparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [liveReadId, setLiveReadId] = useState<string | null>(null);
  const [liveProgress, setLiveProgress] = useState<BaselineProgress[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const detailRequestRef = useRef(0);

  const selected = baselines.find((baseline) => baseline.id === selectedId) ?? null;
  const others = useMemo(
    () => baselines.filter((baseline) => baseline.id !== selectedId),
    [baselines, selectedId],
  );

  async function loadList(nextSelection?: string) {
    setListError(null);
    try {
      const items = sortBaselines(await api.listHostBaselines(connection.id));
      setBaselines(items);
      const wanted = nextSelection ?? selectedId;
      const exists = items.some((baseline) => baseline.id === wanted);
      onSelect(exists ? (wanted ?? null) : (items[0]?.id ?? null));
    } catch (caught) {
      setListError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadList();
  }, [connection.id]);

  useEffect(() => {
    setComparison(null);
    setCompareWithId("");
    setLiveProgress([]);
    setRenaming(false);
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const request = ++detailRequestRef.current;
    setDetailLoading(true);
    void api
      .getHostBaseline(selectedId)
      .then((baseline) => {
        if (request === detailRequestRef.current) setDetail(baseline);
      })
      .catch((caught: unknown) => {
        if (request === detailRequestRef.current) setActionError(errorMessage(caught));
      })
      .finally(() => {
        if (request === detailRequestRef.current) setDetailLoading(false);
      });
  }, [selectedId]);

  async function capture() {
    if (captureId || !chosenSections.length) return;
    const id = crypto.randomUUID();
    setCaptureId(id);
    setProgress([]);
    setActionError(null);
    const channel = new Channel<BaselineProgress>();
    channel.onmessage = (event) => {
      setProgress((current) => [...current, event]);
    };
    try {
      const summary = await api.captureHostBaseline(
        {
          connectionId: connection.id,
          captureId: id,
          label: label.trim() || null,
          sections: chosenSections.length === SECTION_KINDS.length ? null : chosenSections,
        },
        channel,
      );
      setLabel("");
      await loadList(summary.id);
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setCaptureId(null);
    }
  }

  async function stopCapture() {
    if (!captureId) return;
    try {
      await api.cancelHostBaseline(captureId);
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  function toggleSection(kind: BaselineSectionKind, wanted: boolean) {
    setChosenSections((current) =>
      wanted
        ? SECTION_KINDS.filter((candidate) => candidate === kind || current.includes(candidate))
        : current.filter((candidate) => candidate !== kind),
    );
  }

  async function compare(otherId: string) {
    setCompareWithId(otherId);
    setComparison(null);
    if (!selected || !otherId) return;
    if (otherId === LIVE_COMPARISON_ID) {
      await compareWithLive();
      return;
    }
    const other = baselines.find((baseline) => baseline.id === otherId);
    if (!other) return;
    const { baseId, targetId } = orderForComparison(selected, other);
    setComparing(true);
    setActionError(null);
    try {
      setComparison(await api.compareHostBaselines(baseId, targetId));
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setComparing(false);
    }
  }

  // Reading the live host is the same bounded collection a capture runs, minus
  // the save: the comparison is the only thing that outlives it.
  async function compareWithLive() {
    if (!selected || liveReadId) return;
    const readId = crypto.randomUUID();
    setLiveReadId(readId);
    setLiveProgress([]);
    setComparison(null);
    setComparing(true);
    setActionError(null);
    const channel = new Channel<BaselineProgress>();
    channel.onmessage = (event) => {
      setLiveProgress((current) => [...current, event]);
    };
    try {
      setComparison(await api.compareHostBaselineWithLive(selected.id, readId, channel));
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setLiveReadId(null);
      setComparing(false);
    }
  }

  async function stopLiveRead() {
    if (!liveReadId) return;
    try {
      await api.cancelHostBaseline(liveReadId);
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  async function saveLabel() {
    if (!selected) return;
    try {
      await api.renameHostBaseline(selected.id, renameDraft.trim() || null);
      setRenaming(false);
      await loadList(selected.id);
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  async function togglePin() {
    if (!selected) return;
    try {
      await api.setHostBaselinePinned(selected.id, !selected.pinned);
      await loadList(selected.id);
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  async function remove() {
    if (!selected) return;
    try {
      await api.deleteHostBaseline(selected.id);
      await loadList();
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  function moveSelection(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const index = baselines.findIndex((baseline) => baseline.id === selectedId);
    const target = baselines[event.key === "ArrowDown" ? index + 1 : index - 1];
    if (!target) return;
    event.preventDefault();
    onSelect(target.id);
    document.getElementById(`baseline-row-${target.id}`)?.focus();
  }

  if (loading) return <LoadingState label="Reading saved baselines…" />;
  if (listError && !baselines.length) {
    return (
      <ErrorState message={listError} action={<button onClick={() => loadList()}>Retry</button>} />
    );
  }

  return (
    <section className="feature-page split-page">
      <div className="list-panel">
        <header className="page-heading compact-heading">
          <div>
            <h2>Baselines</h2>
            <p>
              A baseline is what this host looked like at one moment. Comparing two shows what
              changed. {baselines.length} saved for this connection.
            </p>
            <small className="unit-scope-note">
              Captured only when you ask. Control Room never collects in the background.
            </small>
          </div>
        </header>
        <div className="baseline-capture">
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Label (optional)"
            aria-label="Baseline label"
            maxLength={80}
            disabled={Boolean(captureId)}
          />
          {captureId ? (
            <button className="secondary-button" type="button" onClick={() => void stopCapture()}>
              <X size={15} /> Stop after this section
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              disabled={!chosenSections.length}
              onClick={() => void capture()}
            >
              <Camera size={15} /> Capture baseline
            </button>
          )}
        </div>
        <fieldset className="baseline-section-choice" disabled={Boolean(captureId)}>
          <legend>Sections</legend>
          {SECTION_KINDS.map((kind) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={chosenSections.includes(kind)}
                onChange={(event) => toggleSection(kind, event.target.checked)}
              />
              <span>{sectionShortLabel(kind)}</span>
            </label>
          ))}
        </fieldset>
        {captureId && (
          <ol className="baseline-progress" aria-live="polite">
            {progress.map((event) => (
              <li key={event.kind}>
                <span>{sectionLabel(event.kind)}</span>
                <span className={`baseline-status baseline-status-${event.status}`}>
                  {statusLabel(event.status)}
                </span>
              </li>
            ))}
            <li className="baseline-progress-count">
              {progress.length} of {progress[0]?.total ?? 5} sections
            </li>
          </ol>
        )}
        {actionError && <p className="inline-error">{actionError}</p>}
        <div className="dense-list" onKeyDown={moveSelection}>
          {baselines.map((baseline) => (
            <button
              className={baseline.id === selectedId ? "dense-row selected-row" : "dense-row"}
              type="button"
              id={`baseline-row-${baseline.id}`}
              key={baseline.id}
              onClick={() => onSelect(baseline.id)}
            >
              <span className="row-main">
                <strong className="baseline-row-title">
                  {baseline.pinned && <Pin size={11} aria-label="Pinned" />}
                  {baselineTitle(baseline)}
                </strong>
                <small>
                  {formatCapturedAt(baseline.capturedAt)}
                  {baseline.identity.hostname ? ` · ${baseline.identity.hostname}` : ""}
                </small>
              </span>
              <span className="row-state">
                {baseline.changesSincePrevious === null
                  ? `${baseline.sections.filter((section) => section.status === "collected").length}/${baseline.sections.length} collected`
                  : `${baseline.changesSincePrevious} changed`}
              </span>
            </button>
          ))}
          {!baselines.length && (
            <EmptyState title="No baselines yet">
              Capture one to record the current units, containers, ports, and filesystems.
            </EmptyState>
          )}
        </div>
      </div>
      <aside className="detail-panel">
        {!selected ? (
          <EmptyState title="Select a baseline" />
        ) : (
          <>
            <header className="baseline-detail-header">
              {renaming ? (
                <div className="baseline-rename">
                  <input
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    aria-label="Baseline label"
                    maxLength={80}
                  />
                  <button type="button" onClick={() => void saveLabel()}>
                    Save
                  </button>
                  <button type="button" onClick={() => setRenaming(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div>
                  <h2>{baselineTitle(selected)}</h2>
                  <p>
                    Captured {formatCapturedAt(selected.capturedAt)}
                    {selected.pinned ? " · pinned, kept past the retention limit" : ""}
                  </p>
                </div>
              )}
              <div className="baseline-detail-actions">
                <button
                  className="icon-button"
                  type="button"
                  aria-label={selected.pinned ? "Unpin baseline" : "Pin baseline"}
                  aria-pressed={selected.pinned}
                  title={
                    selected.pinned
                      ? "Unpin. Newer captures can evict this one again."
                      : "Pin. Keeps this capture past the 20 per connection limit."
                  }
                  onClick={() => void togglePin()}
                >
                  {selected.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Rename baseline"
                  onClick={() => {
                    setRenameDraft(selected.label ?? "");
                    setRenaming(true);
                  }}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Delete baseline"
                  onClick={() => void remove()}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </header>
            <div className="baseline-compare-row">
              <label className="baseline-compare-field">
                <span>Compare with</span>
                <select
                  value={compareWithId}
                  onChange={(event) => void compare(event.target.value)}
                  disabled={Boolean(liveReadId)}
                >
                  <option value="">No comparison</option>
                  <option value={LIVE_COMPARISON_ID}>Live machine state</option>
                  {others.map((baseline) => (
                    <option key={baseline.id} value={baseline.id}>
                      {baselineTitle(baseline)}
                    </option>
                  ))}
                </select>
              </label>
              {compareWithId === LIVE_COMPARISON_ID &&
                (liveReadId ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void stopLiveRead()}
                  >
                    <X size={15} /> Stop after this section
                  </button>
                ) : (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void compareWithLive()}
                  >
                    <RefreshCw size={15} /> Read again
                  </button>
                ))}
            </div>
            {liveReadId && (
              <ol className="baseline-progress baseline-live-progress" aria-live="polite">
                {liveProgress.map((event) => (
                  <li key={event.kind}>
                    <span>{sectionLabel(event.kind)}</span>
                    <span className={`baseline-status baseline-status-${event.status}`}>
                      {statusLabel(event.status)}
                    </span>
                  </li>
                ))}
                <li className="baseline-progress-count">
                  Reading live state · {liveProgress.length} of {liveProgress[0]?.total ?? 5}{" "}
                  sections
                </li>
              </ol>
            )}
            {comparing && !liveReadId && <LoadingState label="Comparing baselines…" />}
            {!comparing && comparison && (
              <BaselineComparisonView comparison={comparison} onError={setActionError} />
            )}
            {!comparing && !comparison && detailLoading && (
              <LoadingState label="Reading baseline…" />
            )}
            {!comparing && !comparison && !detailLoading && detail && (
              <BaselineSectionList connectionId={connection.id} baseline={detail} />
            )}
          </>
        )}
      </aside>
    </section>
  );
}
