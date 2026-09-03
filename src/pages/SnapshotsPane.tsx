import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Camera, Pencil, Pin, PinOff, RefreshCw, Trash2, X } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { SnapshotComparisonView } from "../components/snapshots/SnapshotComparisonView";
import { SnapshotSectionList } from "../components/snapshots/SnapshotSectionList";
import { api, errorMessage } from "../lib/api";
import {
  LIVE_COMPARISON_ID,
  SECTION_KINDS,
  formatCapturedAt,
  orderForComparison,
  sectionLabel,
  snapshotTitle,
  sortSnapshots,
  statusLabel,
} from "../lib/host-snapshots";
import type {
  HostSnapshot,
  HostSnapshotSummary,
  SavedConnection,
  SnapshotComparison,
  SnapshotProgress,
  SnapshotSectionKind,
} from "../types";

interface SnapshotsPaneProps {
  connection: SavedConnection;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

// Capture only ever starts from the button below. There is no timer here and no
// automatic recapture: a snapshot exists because someone asked for one.
export function SnapshotsPane({ connection, selectedId, onSelect }: SnapshotsPaneProps) {
  const [snapshots, setSnapshots] = useState<HostSnapshotSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [chosenSections, setChosenSections] = useState<SnapshotSectionKind[]>(SECTION_KINDS);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [progress, setProgress] = useState<SnapshotProgress[]>([]);
  const [detail, setDetail] = useState<HostSnapshot | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [compareWithId, setCompareWithId] = useState("");
  const [comparison, setComparison] = useState<SnapshotComparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [liveReadId, setLiveReadId] = useState<string | null>(null);
  const [liveProgress, setLiveProgress] = useState<SnapshotProgress[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const detailRequestRef = useRef(0);

  const selected = snapshots.find((snapshot) => snapshot.id === selectedId) ?? null;
  const others = useMemo(
    () => snapshots.filter((snapshot) => snapshot.id !== selectedId),
    [snapshots, selectedId],
  );

  async function loadList(nextSelection?: string) {
    setListError(null);
    try {
      const items = sortSnapshots(await api.listHostSnapshots(connection.id));
      setSnapshots(items);
      const wanted = nextSelection ?? selectedId;
      const exists = items.some((snapshot) => snapshot.id === wanted);
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
      .getHostSnapshot(selectedId)
      .then((snapshot) => {
        if (request === detailRequestRef.current) setDetail(snapshot);
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
    const channel = new Channel<SnapshotProgress>();
    channel.onmessage = (event) => {
      setProgress((current) => [...current, event]);
    };
    try {
      const summary = await api.captureHostSnapshot(
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
      await api.cancelHostSnapshot(captureId);
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  function toggleSection(kind: SnapshotSectionKind, wanted: boolean) {
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
    const other = snapshots.find((snapshot) => snapshot.id === otherId);
    if (!other) return;
    const { baseId, targetId } = orderForComparison(selected, other);
    setComparing(true);
    setActionError(null);
    try {
      setComparison(await api.compareHostSnapshots(baseId, targetId));
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
    const channel = new Channel<SnapshotProgress>();
    channel.onmessage = (event) => {
      setLiveProgress((current) => [...current, event]);
    };
    try {
      setComparison(await api.compareHostSnapshotWithLive(selected.id, readId, channel));
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
      await api.cancelHostSnapshot(liveReadId);
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  async function saveLabel() {
    if (!selected) return;
    try {
      await api.renameHostSnapshot(selected.id, renameDraft.trim() || null);
      setRenaming(false);
      await loadList(selected.id);
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  async function togglePin() {
    if (!selected) return;
    try {
      await api.setHostSnapshotPinned(selected.id, !selected.pinned);
      await loadList(selected.id);
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  async function remove() {
    if (!selected) return;
    try {
      await api.deleteHostSnapshot(selected.id);
      await loadList();
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  function moveSelection(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const index = snapshots.findIndex((snapshot) => snapshot.id === selectedId);
    const target = snapshots[event.key === "ArrowDown" ? index + 1 : index - 1];
    if (!target) return;
    event.preventDefault();
    onSelect(target.id);
    document.getElementById(`snapshot-row-${target.id}`)?.focus();
  }

  if (loading) return <LoadingState label="Reading saved snapshots…" />;
  if (listError && !snapshots.length) {
    return (
      <ErrorState message={listError} action={<button onClick={() => loadList()}>Retry</button>} />
    );
  }

  return (
    <section className="feature-page split-page">
      <div className="list-panel">
        <header className="page-heading compact-heading">
          <div>
            <h2>Snapshots</h2>
            <p>{snapshots.length} saved for this connection</p>
            <small className="unit-scope-note">
              Captured only when you ask. Control Room never collects in the background.
            </small>
          </div>
        </header>
        <div className="snapshot-capture">
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Label (optional)"
            aria-label="Snapshot label"
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
              <Camera size={15} /> Capture snapshot
            </button>
          )}
        </div>
        <fieldset className="snapshot-section-choice" disabled={Boolean(captureId)}>
          <legend>Sections</legend>
          {SECTION_KINDS.map((kind) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={chosenSections.includes(kind)}
                onChange={(event) => toggleSection(kind, event.target.checked)}
              />
              <span>{sectionLabel(kind)}</span>
            </label>
          ))}
        </fieldset>
        {captureId && (
          <ol className="snapshot-progress" aria-live="polite">
            {progress.map((event) => (
              <li key={event.kind}>
                <span>{sectionLabel(event.kind)}</span>
                <span className={`snapshot-status snapshot-status-${event.status}`}>
                  {statusLabel(event.status)}
                </span>
              </li>
            ))}
            <li className="snapshot-progress-count">
              {progress.length} of {progress[0]?.total ?? 5} sections
            </li>
          </ol>
        )}
        {actionError && <p className="inline-error">{actionError}</p>}
        <div className="dense-list" onKeyDown={moveSelection}>
          {snapshots.map((snapshot) => (
            <button
              className={snapshot.id === selectedId ? "dense-row selected-row" : "dense-row"}
              type="button"
              id={`snapshot-row-${snapshot.id}`}
              key={snapshot.id}
              onClick={() => onSelect(snapshot.id)}
            >
              <span className="row-main">
                <strong className="snapshot-row-title">
                  {snapshot.pinned && <Pin size={11} aria-label="Pinned" />}
                  {snapshotTitle(snapshot)}
                </strong>
                <small>
                  {formatCapturedAt(snapshot.capturedAt)}
                  {snapshot.identity.hostname ? ` · ${snapshot.identity.hostname}` : ""}
                </small>
              </span>
              <span className="row-state">
                {snapshot.changesSincePrevious === null
                  ? `${snapshot.sections.filter((section) => section.status === "collected").length}/${snapshot.sections.length} collected`
                  : `${snapshot.changesSincePrevious} changed`}
              </span>
            </button>
          ))}
          {!snapshots.length && (
            <EmptyState title="No snapshots yet">
              Capture one to record the current units, containers, ports, and filesystems.
            </EmptyState>
          )}
        </div>
      </div>
      <aside className="detail-panel">
        {!selected ? (
          <EmptyState title="Select a snapshot" />
        ) : (
          <>
            <header className="snapshot-detail-header">
              {renaming ? (
                <div className="snapshot-rename">
                  <input
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    aria-label="Snapshot label"
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
                  <h2>{snapshotTitle(selected)}</h2>
                  <p>
                    Captured {formatCapturedAt(selected.capturedAt)}
                    {selected.pinned ? " · pinned, kept past the retention limit" : ""}
                  </p>
                </div>
              )}
              <div className="snapshot-detail-actions">
                <button
                  className="icon-button"
                  type="button"
                  aria-label={selected.pinned ? "Unpin snapshot" : "Pin snapshot"}
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
                  aria-label="Rename snapshot"
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
                  aria-label="Delete snapshot"
                  onClick={() => void remove()}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </header>
            <div className="snapshot-compare-row">
              <label className="snapshot-compare-field">
                <span>Compare with</span>
                <select
                  value={compareWithId}
                  onChange={(event) => void compare(event.target.value)}
                  disabled={Boolean(liveReadId)}
                >
                  <option value="">No comparison</option>
                  <option value={LIVE_COMPARISON_ID}>Live machine state</option>
                  {others.map((snapshot) => (
                    <option key={snapshot.id} value={snapshot.id}>
                      {snapshotTitle(snapshot)}
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
              <ol className="snapshot-progress snapshot-live-progress" aria-live="polite">
                {liveProgress.map((event) => (
                  <li key={event.kind}>
                    <span>{sectionLabel(event.kind)}</span>
                    <span className={`snapshot-status snapshot-status-${event.status}`}>
                      {statusLabel(event.status)}
                    </span>
                  </li>
                ))}
                <li className="snapshot-progress-count">
                  Reading live state · {liveProgress.length} of {liveProgress[0]?.total ?? 5}{" "}
                  sections
                </li>
              </ol>
            )}
            {comparing && !liveReadId && <LoadingState label="Comparing snapshots…" />}
            {!comparing && comparison && (
              <SnapshotComparisonView comparison={comparison} onError={setActionError} />
            )}
            {!comparing && !comparison && detailLoading && (
              <LoadingState label="Reading snapshot…" />
            )}
            {!comparing && !comparison && !detailLoading && detail && (
              <SnapshotSectionList connectionId={connection.id} snapshot={detail} />
            )}
          </>
        )}
      </aside>
    </section>
  );
}
