import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Camera, Flag, FlagOff, Pencil, Pin, PinOff, Search, Trash2, X } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { ResizableSplit } from "../components/ResizablePanels";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CredentialDialog } from "../components/CredentialDialog";
import { BaselineTimeline } from "../components/baselines/BaselineTimeline";
import { BaselineCaptureDialog } from "../components/baselines/BaselineCaptureDialog";
import { BaselineComparisonView } from "../components/baselines/BaselineComparisonView";
import { BaselineSectionList } from "../components/baselines/BaselineSectionList";
import {
  BaselineInspector,
  type BaselineInspection,
} from "../components/baselines/BaselineInspector";
import { api, errorMessage } from "../lib/api";
import { elevationAllowed } from "../lib/sudo-elevation";
import type { ComparisonSectionView } from "../lib/host-baselines";
import {
  LIVE_COMPARISON_ID,
  SECTION_KINDS,
  baselineTitle,
  coverageText,
  formatCapturedAt,
  orderForComparison,
  sectionLabel,
  sortBaselines,
  statusLabel,
} from "../lib/host-baselines";
import type {
  BaselineEntry,
  BaselineEntryChange,
  BaselineProgress,
  BaselineSection,
  BaselineSectionDiff,
  BaselineSectionKind,
  BaselineComparison,
  HostBaseline,
  HostBaselineSummary,
  SavedConnection,
} from "../types";

interface BaselinesPaneProps {
  connection: SavedConnection;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** True when the app-wide Allow sudo setting is on; used with the host flag. */
  globalSudoEnabled: boolean;
  /** Deep links the inspector offers when the recorded evidence is exact. */
  onOpenSystemd?: (unit: string) => void;
  onOpenContainer?: (containerId: string) => void;
}

// The pane answers one question per region: what moved between two
// observations (Changes), what this host looked like at one moment (State),
// and what exactly is this resource (Inspector). The timeline holds the
// navigation and everything follows its selection. Nothing here runs on a
// timer, and no host is read until the user asks for a capture or a live
// comparison.
export function BaselinesPane({
  connection,
  selectedId,
  onSelect,
  globalSudoEnabled,
  onOpenSystemd,
  onOpenContainer,
}: BaselinesPaneProps) {
  const [baselines, setBaselines] = useState<HostBaselineSummary[]>([]);
  const [reference, setReference] = useState<HostBaselineSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mode, setMode] = useState<"changes" | "state">("changes");
  const [detail, setDetail] = useState<HostBaseline | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [comparisonTarget, setComparisonTarget] = useState("previous");
  const [comparison, setComparison] = useState<BaselineComparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [showRoutine, setShowRoutine] = useState(false);
  const [search, setSearch] = useState("");
  const [inspection, setInspection] = useState<BaselineInspection | null>(null);
  const [captureDialog, setCaptureDialog] = useState(false);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [progress, setProgress] = useState<BaselineProgress[]>([]);
  const [liveReadId, setLiveReadId] = useState<string | null>(null);
  const [liveProgress, setLiveProgress] = useState<BaselineProgress[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<HostBaselineSummary | null>(null);
  const [clearReferenceAsk, setClearReferenceAsk] = useState(false);
  const [sudoAsk, setSudoAsk] = useState(false);
  const [sudoNoticed, setSudoNoticed] = useState(false);
  const [slide, setSlide] = useState<"newer" | "older" | null>(null);
  const detailRequestRef = useRef(0);
  const comparisonRequestRef = useRef(0);
  const lastSelectedIndexRef = useRef<number | null>(null);
  const lastComparisonKeyRef = useRef<string | null>(null);
  const lastCaptureSectionsRef = useRef<BaselineSectionKind[]>(SECTION_KINDS);

  const selected = baselines.find((baseline) => baseline.id === selectedId) ?? null;
  const indexOfSelected = useMemo(
    () => baselines.findIndex((baseline) => baseline.id === selectedId),
    [baselines, selectedId],
  );
  const previousCapture = indexOfSelected >= 0 ? (baselines[indexOfSelected + 1] ?? null) : null;
  const referenceId = reference?.id ?? null;
  const sudoAllowed = elevationAllowed(globalSudoEnabled, connection.sudoEnabled);

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

  async function loadReference() {
    try {
      setReference(await api.getHostBaselineReference(connection.id));
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  useEffect(() => {
    // Each connection carries its own captures; switching targets resets the
    // exploration context completely rather than mixing histories.
    setMode("changes");
    setComparisonTarget("previous");
    setInspection(null);
    setRenaming(false);
    setSudoNoticed(false);
    lastSelectedIndexRef.current = null;
    lastComparisonKeyRef.current = null;
    setLoading(true);
    void loadList();
    void loadReference();
  }, [connection.id]);

  // A direction-aware slide accompanies moving between captures: content
  // moves toward the present when navigating to a newer capture and back when
  // going older. Reduced motion applies the new content immediately.
  useEffect(() => {
    if (indexOfSelected === -1) {
      lastSelectedIndexRef.current = null;
      return;
    }
    const previousIndex = lastSelectedIndexRef.current;
    lastSelectedIndexRef.current = indexOfSelected;
    if (previousIndex !== null && previousIndex !== indexOfSelected) {
      setSlide(indexOfSelected < previousIndex ? "newer" : "older");
    }
  }, [indexOfSelected]);

  // The detail load is guarded: a response from an abandoned selection can
  // never overwrite the capture the user is looking at now.
  useEffect(() => {
    const request = ++detailRequestRef.current;
    comparisonRequestRef.current += 1;
    setComparison(null);
    setComparing(false);
    setDetail(null);
    setDetailLoading(false);
    setInspection(null);
    if (!selectedId) return;
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
    return () => {
      detailRequestRef.current += 1;
      comparisonRequestRef.current += 1;
    };
  }, [selectedId]);

  // The key includes the resolved target, so a comparison runs not only when
  // the user picks a target but also when the list loads and the previous
  // capture first becomes available.
  const resolvedTarget =
    comparisonTarget === "previous"
      ? (previousCapture?.id ?? "")
      : comparisonTarget === "reference"
        ? (referenceId ?? "")
        : comparisonTarget;
  const comparisonKey = `${selectedId}:${resolvedTarget}`;

  useEffect(() => {
    if (mode !== "changes" || !selected || !resolvedTarget) return;
    if (lastComparisonKeyRef.current === comparisonKey) return;
    lastComparisonKeyRef.current = comparisonKey;
    if (resolvedTarget === LIVE_COMPARISON_ID) {
      void compareWithLive();
    } else if (resolvedTarget !== selected.id) {
      void compareWith(resolvedTarget);
    }
  }, [comparisonKey, mode]);

  async function compareWith(otherId: string) {
    if (!selected) return;
    const other = baselines.find((baseline) => baseline.id === otherId);
    if (!other) return;
    const { baseId, targetId } = orderForComparison(selected, other);
    const request = ++comparisonRequestRef.current;
    setComparing(true);
    setActionError(null);
    try {
      const result = await api.compareHostBaselines(baseId, targetId);
      if (request === comparisonRequestRef.current) setComparison(result);
    } catch (caught) {
      if (request === comparisonRequestRef.current) setActionError(errorMessage(caught));
    } finally {
      if (request === comparisonRequestRef.current) setComparing(false);
    }
  }

  // Reading the live host is the same bounded collection a capture runs, minus
  // the save: the comparison is the only thing that outlives it.
  async function compareWithLive(sudoPassword: string | null = null) {
    if (!selected || liveReadId) return;
    const request = ++comparisonRequestRef.current;
    const readId = crypto.randomUUID();
    setLiveReadId(readId);
    setLiveProgress([]);
    setComparison(null);
    setComparing(true);
    setActionError(null);
    const channel = new Channel<BaselineProgress>();
    channel.onmessage = (event) => {
      if (request === comparisonRequestRef.current)
        setLiveProgress((current) => [...current, event]);
    };
    try {
      const result = await api.compareHostBaselineWithLive(
        selected.id,
        readId,
        channel,
        connection.id,
        sudoPassword,
      );
      if (request === comparisonRequestRef.current) setComparison(result);
    } catch (caught) {
      if (request === comparisonRequestRef.current) setActionError(errorMessage(caught));
    } finally {
      setLiveReadId(null);
      if (request === comparisonRequestRef.current) setComparing(false);
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

  // Captures only ever start from the dialog. A capture exists because someone
  // asked for one; progress carries what actually finished.
  async function capture(label: string, sections: BaselineSectionKind[], sudoPassword?: string) {
    if (captureId) return;
    lastCaptureSectionsRef.current = sections;
    const id = crypto.randomUUID();
    setCaptureId(id);
    setProgress([]);
    setActionError(null);
    const channel = new Channel<BaselineProgress>();
    let permissionLimited = false;
    channel.onmessage = (event) => {
      setProgress((current) => [...current, event]);
      if (event.status === "unavailable") permissionLimited = true;
    };
    try {
      const summary = await api.captureHostBaseline(
        {
          connectionId: connection.id,
          captureId: id,
          label: label.trim() || null,
          sections: sections.length === SECTION_KINDS.length ? null : sections,
        },
        channel,
        sudoPassword ?? null,
      );
      setCaptureDialog(false);
      setProgress([]);
      await loadList(summary.id);
      // The new capture joins the timeline and becomes the investigation
      // context; its difference against the previous capture is what changes.
      setMode("changes");
      setComparisonTarget("previous");
      setSudoNoticed(permissionLimited);
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

  async function markReference() {
    if (!selected) return;
    try {
      await api.setHostBaselineReference(selected.id);
      await loadReference();
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  async function clearReference() {
    setClearReferenceAsk(false);
    try {
      await api.clearHostBaselineReference(connection.id);
      await loadReference();
      // A comparison pointing at the reference needs a target again; the
      // previous capture is the default anchor everywhere.
      if (comparisonTarget === "reference") setComparisonTarget("previous");
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  async function remove(target: HostBaselineSummary) {
    try {
      await api.deleteHostBaseline(target.id);
      setDeleteTarget(null);
      await loadList();
      if (target.id === referenceId) {
        await loadReference();
        if (comparisonTarget === "reference") setComparisonTarget("previous");
      }
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  function inspectFromDiff(
    section: BaselineSectionDiff | ComparisonSectionView,
    target: {
      entry?: BaselineEntry;
      change?: BaselineEntryChange;
      type: "added" | "removed" | "changed";
    },
  ) {
    const from = target.entry ?? null;
    setInspection({
      sectionKind: section.kind as BaselineSectionKind,
      entry:
        from ??
        (target.change
          ? { identity: target.change.identity, label: target.change.label, facts: [] }
          : null),
      change: target.change ?? null,
      changeType: target.type,
      removalsIndeterminate: section.removalsIndeterminate,
      sectionNote: section.note ?? null,
    });
  }

  function inspectStateEntry(section: BaselineSection, entry: BaselineEntry) {
    setInspection({
      sectionKind: section.kind as BaselineSectionKind,
      entry,
      change: null,
      changeType: null,
      removalsIndeterminate: false,
      sectionNote: section.message ?? null,
    });
  }

  if (loading) return <LoadingState label="Reading saved captures…" />;
  if (listError && !baselines.length) {
    return (
      <ErrorState
        message={listError}
        action={<button onClick={() => void loadList()}>Retry</button>}
      />
    );
  }

  return (
    <ResizableSplit name="Baselines" className="feature-page split-page baseline-explorer">
      <div className="baseline-workspace-column">
        <header className="baselines-command-header">
          <div>
            <h2>Baselines</h2>
            <p>
              {connection.displayName}
              {baselines[0] ? ` · Last capture ${formatCapturedAt(baselines[0].capturedAt)}` : ""}
              {` · ${baselines.length} ${baselines.length === 1 ? "capture" : "captures"}`}
            </p>
          </div>
          <div className="baselines-command-actions">
            <button
              className="primary-button"
              type="button"
              disabled={Boolean(captureId)}
              title="Capture now. Control Room never collects in the background."
              onClick={() => {
                setProgress([]);
                setCaptureDialog(true);
              }}
            >
              <Camera size={15} /> Capture baseline
            </button>
          </div>
        </header>
        {actionError && <p className="inline-error">{actionError}</p>}
        {sudoNoticed && (
          <p className="inline-warning">
            Some sections could not be read by this account.
            {sudoAllowed ? (
              <>
                {" "}
                <button className="link-button" type="button" onClick={() => setSudoAsk(true)}>
                  Retry with sudo
                </button>{" "}
                runs a new capture with elevation; saved captures are never rewritten.
              </>
            ) : (
              " Allow sudo for Structured Operations to record them."
            )}
          </p>
        )}
        {!baselines.length && (
          <EmptyState title="No captures yet">
            Capture one to record what this host looks like. Control Room never collects in the
            background.
          </EmptyState>
        )}
        {!!baselines.length && (
          <BaselineTimeline
            baselines={baselines}
            selectedId={selectedId}
            referenceId={referenceId}
            onSelect={onSelect}
            onLatest={() => baselines[0] && onSelect(baselines[0].id)}
            onReference={() => referenceId && onSelect(referenceId)}
          />
        )}
        {selected && (
          <div
            className={
              slide === "newer"
                ? "baseline-workspace-slide baseline-slide-newer"
                : slide === "older"
                  ? "baseline-workspace-slide baseline-slide-older"
                  : "baseline-workspace-slide"
            }
            key={selected.id}
            onAnimationEnd={() => setSlide(null)}
          >
            <div className="baseline-context">
              <div className="baseline-context-heading">
                {renaming ? (
                  <div className="baseline-rename">
                    <input
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      aria-label="Capture label"
                      maxLength={80}
                      autoFocus
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
                    <h3>{baselineTitle(selected)}</h3>
                    <p>
                      Captured {formatCapturedAt(selected.capturedAt)} · {coverageText(selected)}
                      {referenceId === selected.id ? " · reference" : ""}
                      {selected.identity.hostname ? ` · ${selected.identity.hostname}` : ""}
                    </p>
                  </>
                )}
                <div className="baseline-context-actions">
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={selected.pinned ? "Unpin capture" : "Pin capture"}
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
                    aria-label="Rename capture"
                    title="Rename this capture"
                    onClick={() => {
                      setRenameDraft(selected.label ?? "");
                      setRenaming(true);
                    }}
                  >
                    <Pencil size={15} />
                  </button>
                  {referenceId === selected.id ? (
                    <button
                      className="icon-button"
                      type="button"
                      aria-label="Clear reference"
                      title="Stop using this capture as the reference for comparisons."
                      onClick={() => setClearReferenceAsk(true)}
                    >
                      <FlagOff size={15} />
                    </button>
                  ) : (
                    <button
                      className="icon-button"
                      type="button"
                      aria-label="Mark as reference"
                      title="Use this capture as the comparison anchor for this host."
                      onClick={() => void markReference()}
                    >
                      <Flag size={15} />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="Delete capture"
                    title="Delete this stored snapshot."
                    onClick={() => setDeleteTarget(selected)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <div className="baseline-context-tools">
                <div className="baseline-mode-tabs" role="tablist" aria-label="Capture view">
                  {(["changes", "state"] as const).map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      role="tab"
                      aria-selected={mode === candidate}
                      className={
                        mode === candidate ? "baseline-mode-tab selected" : "baseline-mode-tab"
                      }
                      onClick={() => setMode(candidate)}
                    >
                      {candidate === "changes" ? "Changes" : "State"}
                    </button>
                  ))}
                </div>
                <label className="baseline-compare-field">
                  <span>Compare with</span>
                  <select
                    value={comparisonTarget}
                    onChange={(event) => {
                      setComparisonTarget(event.target.value);
                      setInspection(null);
                    }}
                    disabled={Boolean(liveReadId)}
                  >
                    <option value="previous">Previous capture</option>
                    {reference && reference.id !== selected.id && (
                      <option value="reference">{`Reference: ${baselineTitle(reference)}`}</option>
                    )}
                    {baselines
                      .filter(
                        (baseline) =>
                          baseline.id !== selected.id &&
                          baseline.id !== previousCapture?.id &&
                          baseline.id !== reference?.id,
                      )
                      .map((baseline) => (
                        <option key={baseline.id} value={baseline.id}>
                          {baselineTitle(baseline)}
                        </option>
                      ))}
                    <option value={LIVE_COMPARISON_ID}>Live machine (unsaved read)</option>
                  </select>
                </label>
                <label className="baseline-search-field">
                  <Search size={14} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search"
                    aria-label="Search baseline"
                  />
                </label>
              </div>
            </div>
            {mode === "changes" && (
              <div className="baseline-workspace">
                {!comparing && !comparison && baselines.length === 1 ? (
                  <EmptyState title="Only this capture is stored">
                    Capture again to compare two saved moments, or compare with the live machine for
                    an unsaved read of right now.
                  </EmptyState>
                ) : !comparing && !comparison && !previousCapture ? (
                  <EmptyState title="Earliest capture selected">
                    This is the oldest capture. Choose another capture or the live machine in
                    Compare with.
                  </EmptyState>
                ) : comparing ? (
                  <LoadingState
                    label={liveReadId ? "Reading the live host…" : "Comparing captures…"}
                  />
                ) : (
                  comparison && (
                    <BaselineComparisonView
                      comparison={comparison}
                      showRoutine={showRoutine}
                      search={search}
                      selectedIdentity={
                        inspection?.entry?.identity ?? inspection?.change?.identity ?? null
                      }
                      onShowRoutineChange={setShowRoutine}
                      onInspectEntry={(section, entry, changeType) =>
                        inspectFromDiff(section, { entry, type: changeType })
                      }
                      onInspectChange={(section, change) =>
                        inspectFromDiff(section, { change, type: "changed" })
                      }
                      onError={setActionError}
                    />
                  )
                )}
                {liveReadId && (
                  <ol className="baseline-progress baseline-live-progress" aria-live="polite">
                    {liveProgress.map((event) => (
                      <li key={event.kind}>
                        <span>{sectionLabel(event.kind as BaselineSectionKind)}</span>
                        <span className={`baseline-status baseline-status-${event.status}`}>
                          {statusLabel(event.status)}
                        </span>
                      </li>
                    ))}
                    <li className="baseline-progress-count">
                      Reading live state · {liveProgress.length} of{" "}
                      {liveProgress[0]?.total ?? SECTION_KINDS.length} sections
                    </li>
                    <li>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void stopLiveRead()}
                      >
                        <X size={15} /> Stop after this section
                      </button>
                    </li>
                  </ol>
                )}
              </div>
            )}
            {mode === "state" && (
              <div className="baseline-workspace">
                {detailLoading ? (
                  <LoadingState label="Reading capture…" />
                ) : detail ? (
                  <BaselineSectionList
                    baseline={detail}
                    selectedIdentity={inspection?.entry?.identity ?? null}
                    onInspect={inspectStateEntry}
                  />
                ) : (
                  <EmptyState title="Nothing recorded" />
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <aside className="baseline-inspector-pane">
        {inspection ? (
          <BaselineInspector
            connectionId={connection.id}
            inspection={inspection}
            onClose={() => setInspection(null)}
            onOpenSystemd={onOpenSystemd}
            onOpenContainer={onOpenContainer}
          />
        ) : (
          <EmptyState title="Select a change">
            Choose a difference or an entry to see its exact facts, classification, and history.
          </EmptyState>
        )}
      </aside>
      {captureDialog && (
        <BaselineCaptureDialog
          connectionName={connection.displayName}
          running={Boolean(captureId)}
          progress={progress}
          permissionNote={
            sudoAllowed
              ? null
              : "Allow sudo is off for this host, so sections that need root record less."
          }
          onRequestCapture={(label, sections) => void capture(label, sections)}
          onStopCapture={() => void stopCapture()}
          onClose={() => {
            if (!captureId) setCaptureDialog(false);
          }}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          title="Delete capture?"
          message={
            <>
              Delete “{baselineTitle(deleteTarget)}”? This stored snapshot cannot be recovered; you
              would need to capture the host again.
              {deleteTarget.id === referenceId
                ? " It is this host's reference capture, so the reference clears with it."
                : ""}
            </>
          }
          confirmLabel="Delete capture"
          danger
          onConfirm={() => void remove(deleteTarget)}
          onClose={() => setDeleteTarget(null)}
        />
      )}
      {clearReferenceAsk && reference && (
        <ConfirmDialog
          title="Clear reference?"
          message={
            <>
              Stop using “{baselineTitle(reference)}” as the reference for comparisons on{" "}
              {connection.displayName}? The capture itself stays saved.
            </>
          }
          confirmLabel="Clear reference"
          cancelLabel="Keep reference"
          onConfirm={() => void clearReference()}
          onClose={() => setClearReferenceAsk(false)}
        />
      )}
      {sudoAsk && (
        <CredentialDialog
          connectionLabel={connection.displayName}
          onClose={() => setSudoAsk(false)}
          onSubmit={async (password) => {
            setSudoAsk(false);
            // A retry is a new capture over the same sections. The earlier
            // snapshot keeps its facts; nothing already saved is edited.
            setSudoNoticed(false);
            setProgress([]);
            setCaptureDialog(true);
            await capture("", lastCaptureSectionsRef.current, password);
          }}
        />
      )}
    </ResizableSplit>
  );
}
