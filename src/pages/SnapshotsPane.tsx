import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Camera, Pencil, Trash2, X } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import {
  changeCount,
  comparisonSummary,
  formatCapturedAt,
  identityWarning,
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
  SnapshotSection,
  SnapshotSectionDiff,
  SnapshotSectionStatus,
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
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [progress, setProgress] = useState<SnapshotProgress[]>([]);
  const [detail, setDetail] = useState<HostSnapshot | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [compareWithId, setCompareWithId] = useState("");
  const [comparison, setComparison] = useState<SnapshotComparison | null>(null);
  const [comparing, setComparing] = useState(false);
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
    if (captureId) return;
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
        connection.id,
        id,
        label.trim() || null,
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

  async function compare(otherId: string) {
    setCompareWithId(otherId);
    setComparison(null);
    if (!selected || !otherId) return;
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

  async function remove() {
    if (!selected) return;
    try {
      await api.deleteHostSnapshot(selected.id);
      await loadList();
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
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
            <button className="primary-button" type="button" onClick={() => void capture()}>
              <Camera size={15} /> Capture snapshot
            </button>
          )}
        </div>
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
        <div className="dense-list">
          {snapshots.map((snapshot) => (
            <button
              className={snapshot.id === selectedId ? "dense-row selected-row" : "dense-row"}
              type="button"
              key={snapshot.id}
              onClick={() => onSelect(snapshot.id)}
            >
              <span className="row-main">
                <strong>{snapshotTitle(snapshot)}</strong>
                <small>{formatCapturedAt(snapshot.capturedAt)}</small>
              </span>
              <span className="row-state">
                {snapshot.sections.filter((section) => section.status === "collected").length}/
                {snapshot.sections.length} collected
              </span>
            </button>
          ))}
          {!snapshots.length && (
            <EmptyState title="No snapshots yet">
              Capture one to record the current units, containers, listeners, and filesystems.
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
                <>
                  <h2>{snapshotTitle(selected)}</h2>
                  <p>
                    Captured {formatCapturedAt(selected.capturedAt)} · schema v
                    {selected.schemaVersion}
                  </p>
                </>
              )}
              <div className="snapshot-detail-actions">
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
            <label className="snapshot-compare-field">
              <span>Compare with</span>
              <select
                value={compareWithId}
                onChange={(event) => void compare(event.target.value)}
                disabled={!others.length}
              >
                <option value="">No comparison</option>
                {others.map((snapshot) => (
                  <option key={snapshot.id} value={snapshot.id}>
                    {snapshotTitle(snapshot)}
                  </option>
                ))}
              </select>
            </label>
            {comparing && <LoadingState label="Comparing snapshots…" />}
            {!comparing && comparison && <ComparisonView comparison={comparison} />}
            {!comparing && !comparison && detailLoading && (
              <LoadingState label="Reading snapshot…" />
            )}
            {!comparing && !comparison && !detailLoading && detail && (
              <SnapshotView snapshot={detail} />
            )}
          </>
        )}
      </aside>
    </section>
  );
}

function StatusChip({ status }: { status: SnapshotSectionStatus }) {
  return <span className={`snapshot-status snapshot-status-${status}`}>{statusLabel(status)}</span>;
}

function SnapshotView({ snapshot }: { snapshot: HostSnapshot }) {
  return (
    <div className="snapshot-sections">
      {snapshot.sections.map((section) => (
        <SectionView key={section.kind} section={section} />
      ))}
    </div>
  );
}

function SectionView({ section }: { section: SnapshotSection }) {
  return (
    <section className="snapshot-section">
      <header>
        <h3>{sectionLabel(section.kind)}</h3>
        <StatusChip status={section.status} />
        <span className="snapshot-section-count">{section.entries.length} recorded</span>
      </header>
      {section.message && <p className="inline-warning">{section.message}</p>}
      {section.kind === "host" &&
        section.entries.map((entry) => (
          <dl className="detail-list" key={entry.identity}>
            {entry.facts.map((fact) => (
              <div key={fact.name}>
                <dt>{fact.name}</dt>
                <dd className="technical">{fact.value}</dd>
              </div>
            ))}
          </dl>
        ))}
    </section>
  );
}

function ComparisonView({ comparison }: { comparison: SnapshotComparison }) {
  const warning = identityWarning(comparison);
  return (
    <div className="snapshot-sections">
      <p className="snapshot-comparison-summary">
        {snapshotTitle(comparison.base)} → {snapshotTitle(comparison.target)}:{" "}
        {comparisonSummary(comparison)}
      </p>
      {warning && <p className="inline-warning">{warning}</p>}
      {!comparison.schemaCompatible && (
        <p className="inline-warning">
          These captures use different schema versions, so no section can be compared.
        </p>
      )}
      {comparison.sections.map((section) => (
        <SectionDiffView key={section.kind} diff={section} />
      ))}
    </div>
  );
}

function SectionDiffView({ diff }: { diff: SnapshotSectionDiff }) {
  const changes = changeCount(diff);
  return (
    <section className="snapshot-section">
      <header>
        <h3>{sectionLabel(diff.kind)}</h3>
        <StatusChip status={diff.baseStatus} />
        <span aria-hidden="true">→</span>
        <StatusChip status={diff.targetStatus} />
      </header>
      {diff.note && <p className="inline-warning">{diff.note}</p>}
      {diff.comparable && (
        <p className="snapshot-section-count">
          {changes === 0
            ? `No change across ${diff.unchangedCount} compared entries`
            : `${changes} changed of ${changes + diff.unchangedCount} compared entries`}
        </p>
      )}
      {!!diff.added.length && (
        <ul className="snapshot-change-list">
          {diff.added.map((entry) => (
            <li key={`added-${entry.identity}`}>
              <span className="snapshot-change-mark snapshot-change-added">Added</span>
              <code>{entry.label}</code>
            </li>
          ))}
        </ul>
      )}
      {!!diff.removed.length && (
        <ul className="snapshot-change-list">
          {diff.removed.map((entry) => (
            <li key={`removed-${entry.identity}`}>
              <span className="snapshot-change-mark snapshot-change-removed">Removed</span>
              <code>{entry.label}</code>
            </li>
          ))}
        </ul>
      )}
      {!!diff.changed.length && (
        <ul className="snapshot-change-list">
          {diff.changed.map((entry) => (
            <li key={`changed-${entry.identity}`}>
              <span className="snapshot-change-mark">Changed</span>
              <code>{entry.label}</code>
              <ul className="snapshot-fact-list">
                {entry.changes.map((change) => (
                  <li key={change.name}>
                    <span>{change.name}</span>
                    <code>{change.baseValue ?? "not recorded"}</code>
                    <span aria-hidden="true">→</span>
                    <code>{change.targetValue ?? "not recorded"}</code>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
