import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, FileClock, RefreshCw } from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { ErrorState, LoadingState } from "../components/PanelState";
import { BootEventInspector } from "../components/boot/BootEventInspector";
import { BootJournalLane } from "../components/boot/BootJournalLane";
import { BootTimeline, type ReplayLane } from "../components/boot/BootTimeline";
import { BootTransport } from "../components/boot/BootTransport";
import { api, errorMessage } from "../lib/api";
import { bootLabel, durationToMillis } from "../lib/boot-diagnostics";
import {
  BOOT_REPLAY_WINDOW_OPTIONS,
  DEFAULT_BOOT_REPLAY_WINDOW_SECONDS,
  MAX_BOOT_REPLAY_WINDOW_SECONDS,
  MIN_BOOT_REPLAY_WINDOW_SECONDS,
  describeReplayCoverage,
  emptyReplayEvidence,
  groupReplayMarkers,
  mergeReplayEvidence,
  nextNotableMarker,
  normalizeWindowSeconds,
  previousNotableMarker,
  shouldContinueReplayPagination,
  upperBound,
  windowMicroseconds,
  type ReplayEvidence,
  type ReplayEvent,
  type ReplayMarker,
} from "../lib/boot-replay";
import { useBootReplayClock } from "../hooks/use-boot-replay-clock";
import type { BootDiagnostics, BootSection, LogSourceSelection, SavedConnection } from "../types";

type ReplayStatus =
  | { kind: "idle" }
  | { kind: "loading"; evidence: ReplayEvidence | null }
  | { kind: "ready"; evidence: ReplayEvidence }
  | { kind: "permission"; evidence: ReplayEvidence }
  | { kind: "error"; fetchError: string; evidence: ReplayEvidence | null };

function collectedLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleTimeString();
}

function SectionHeading({ title, collectedAt }: { title: string; collectedAt: string }) {
  return (
    <header className="boot-section-heading">
      <h3>{title}</h3>
      <span>Collected {collectedLabel(collectedAt)}</span>
    </header>
  );
}

function SectionError<T>({
  section,
  action,
}: {
  section: BootSection<T>;
  action?: React.ReactNode;
}) {
  return (
    <div className="boot-section-error" role="status">
      <AlertCircle size={15} />
      <span>{section.error ?? "Section unavailable"}</span>
      {action}
    </div>
  );
}

export function BootDiagnosticsPane({
  connection,
  snapshot,
  onSnapshotChange,
  onViewLogs,
  onOpenSystemd,
}: {
  connection: SavedConnection;
  snapshot: BootDiagnostics | null;
  onSnapshotChange: (snapshot: BootDiagnostics) => void;
  onViewLogs: (source: LogSourceSelection) => void;
  onOpenSystemd?: (unit: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sudoOpen, setSudoOpen] = useState(false);
  const [windowSeconds, setWindowSeconds] = useState(DEFAULT_BOOT_REPLAY_WINDOW_SECONDS);
  const [windowCustom, setWindowCustom] = useState(false);
  const [replayStatus, setReplayStatus] = useState<ReplayStatus>({ kind: "idle" });
  const [selectedMarker, setSelectedMarker] = useState<ReplayMarker | null>(null);
  const requestRef = useRef(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const windowUs = windowMicroseconds(windowSeconds);
  const replayRequestRef = useRef(0);
  const evidenceRef = useRef<ReplayEvidence | null>(null);
  const axisRef = useRef<HTMLDivElement | null>(null);

  const handleTick = useCallback(
    (positionUs: number) => {
      axisRef.current?.style.setProperty(
        "--replay-progress",
        `${windowUs > 0 ? (positionUs / windowUs) * 100 : 0}%`,
      );
    },
    [windowUs],
  );
  const clock = useBootReplayClock({ durationUs: windowUs, onTick: handleTick });

  async function collect(bootId: string | null = null, sudoPassword: string | null = null) {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.collectBootDiagnostics(connection.id, bootId, sudoPassword);
      if (request !== requestRef.current) return;
      onSnapshotChange(next);
      setSudoOpen(false);
    } catch (caught) {
      if (request !== requestRef.current) return;
      setError(errorMessage(caught));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }

  async function runReplay(
    bootId: string,
    base: ReplayEvidence | null,
    sudoPassword: string | null,
  ) {
    const generation = ++replayRequestRef.current;
    let evidence = base;
    let pages = 0;
    let more = base === null || shouldContinueReplayPagination(base, windowUs, pages);
    if (!more) {
      setReplayStatus({ kind: "ready", evidence: evidence ?? emptyReplayEvidence() });
      return;
    }
    if (base) setReplayStatus({ kind: "loading", evidence: base });
    try {
      while (more) {
        const page = await api.collectBootReplay(
          connection.id,
          bootId,
          evidence?.managerCursor ?? null,
          evidence?.alertCursor ?? null,
          sudoPassword,
        );
        if (replayRequestRef.current !== generation) return;
        evidence = mergeReplayEvidence(evidence, page);
        evidenceRef.current = evidence;
        pages += 1;
        if (evidence.permissionRequired) {
          setReplayStatus({ kind: "permission", evidence });
          return;
        }
        more = shouldContinueReplayPagination(evidence, windowUs, pages);
        setReplayStatus({ kind: more ? "loading" : "ready", evidence });
      }
    } catch (caught) {
      if (replayRequestRef.current !== generation) return;
      setReplayStatus({ kind: "error", fetchError: errorMessage(caught), evidence });
    }
  }

  const selectedBootId = snapshot?.selectedBootId ?? null;
  const bootScopeRef = useRef<{ connectionId: string; bootId: string | null }>({
    connectionId: connection.id,
    bootId: null,
  });
  const windowRef = useRef(windowSeconds);

  // Switching boots or hosts starts over: playback stops, the selection and
  // every fetched page are dropped, and the new boot is read from scratch. A
  // window change only extends (or simply re-views) the evidence it already
  // has, preserving the playhead.
  useEffect(() => {
    if (!selectedBootId) return;
    const scope = bootScopeRef.current;
    const bootChanged = scope.connectionId !== connection.id || scope.bootId !== selectedBootId;
    const windowChanged = !bootChanged && windowRef.current !== windowSeconds;
    bootScopeRef.current = { connectionId: connection.id, bootId: selectedBootId };
    windowRef.current = windowSeconds;
    if (bootChanged) {
      clock.pause();
      clock.seek(0);
      setSelectedMarker(null);
      evidenceRef.current = null;
      setReplayStatus({ kind: "loading", evidence: null });
      void runReplay(selectedBootId, null, null);
    } else if (windowChanged) {
      void runReplay(selectedBootId, evidenceRef.current, null);
    }
  }, [selectedBootId, connection.id, windowSeconds, clock.pause, clock.seek]);

  useEffect(() => {
    void collect();
    return () => {
      requestRef.current += 1;
      replayRequestRef.current += 1;
    };
  }, [connection.id]);

  // Everything below must run on every render: the loading and error early
  // returns come after the derived-hook block.
  const evidence = replayStatus.kind === "idle" ? null : (replayStatus.evidence ?? null);
  const coverage = describeReplayCoverage(
    evidence,
    windowUs,
    replayStatus.kind === "error" ? replayStatus.fetchError : null,
  );

  const inWindowEvents = useMemo(
    () => (evidence?.timedEvents ?? []).filter((event) => (event.offsetUs ?? 0) <= windowUs),
    [evidence, windowUs],
  );
  const markers = useMemo(
    () => groupReplayMarkers(inWindowEvents, windowUs),
    [inWindowEvents, windowUs],
  );
  const lanes = useMemo<ReplayLane[]>(() => {
    const definitions = [
      { id: "milestones", label: "Milestones", categories: ["milestone"] as const },
      { id: "units", label: "Unit events", categories: ["unit"] as const },
      {
        id: "alerts",
        label: "Warnings & failures",
        categories: ["warning", "error"] as const,
      },
    ];
    return definitions
      .map((definition) => ({
        id: definition.id,
        label: definition.label,
        markers: markers.filter((marker) =>
          (definition.categories as readonly string[]).includes(marker.category),
        ),
      }))
      .filter((lane) => lane.markers.length > 0);
  }, [markers]);

  if (loading && !snapshot) return <LoadingState label="Inspecting the current boot…" />;
  if (error && !snapshot) {
    return (
      <ErrorState message={error} action={<button onClick={() => void collect()}>Retry</button>} />
    );
  }

  const boots = [...(snapshot?.boots.data ?? [])].sort(
    (left, right) => Number(right.current) - Number(left.current) || right.index - left.index,
  );
  const selectedBoot = boots.find((boot) => boot.id === snapshot?.selectedBootId) ?? null;
  const currentSelected = selectedBoot?.current ?? snapshot?.selectedBootId === null;

  const sudoRetry = (section: BootSection<unknown>) =>
    section.permissionRequired ? (
      <button className="secondary-button" type="button" onClick={() => setSudoOpen(true)}>
        Retry with sudo
      </button>
    ) : undefined;

  const windowNotables = inWindowEvents.filter(
    (event) => event.category === "error" || event.category === "warning",
  );
  const observedCount = upperBound(inWindowEvents, clock.positionUs);
  const observedFailures = inWindowEvents
    .filter((event) => event.category === "error")
    .filter((event) => (event.offsetUs ?? 0) <= clock.positionUs).length;
  const observedWarnings = inWindowEvents
    .filter((event) => event.category === "warning")
    .filter((event) => (event.offsetUs ?? 0) <= clock.positionUs).length;

  const goToMarker = (marker: ReplayMarker | null) => {
    if (!marker) return;
    clock.seek(marker.offsetUs);
    setSelectedMarker(marker);
  };

  function goToEvent(event: ReplayEvent) {
    if (event.offsetUs !== null) clock.seek(event.offsetUs);
    const marker = markers.find(
      (candidate) =>
        candidate.category === event.category &&
        (event.offsetUs ?? 0) >= candidate.spanUs[0] &&
        (event.offsetUs ?? 0) <= candidate.spanUs[1],
    );
    setSelectedMarker(marker ?? null);
  }

  const replayLoading = replayStatus.kind === "loading" && !evidence;
  const replayError = replayStatus.kind === "error" ? replayStatus.fetchError : null;
  const replayPermission = replayStatus.kind === "permission";
  const hasMorePages = !!evidence && shouldContinueReplayPagination(evidence, windowUs, 0);
  const playheadStatus = replayLoading
    ? "Reading retained journal evidence…"
    : replayPermission
      ? "The connecting account cannot read this boot's journal. Retry with sudo."
      : replayError
        ? replayError
        : !inWindowEvents.length
          ? "No events were retained in this replay window."
          : observedCount
            ? `At playhead: ${observedCount} events` +
              (observedFailures ? ` · ${observedFailures} failures` : "") +
              (observedWarnings ? ` · ${observedWarnings} warnings` : "")
            : "Nothing observed at this position yet.";

  const slowUnits = snapshot?.slowUnits.data ?? [];
  const slowest = slowUnits.reduce((longest, unit) => {
    const millis = durationToMillis(unit.duration);
    return millis !== null && millis > longest ? millis : longest;
  }, 0);
  const failedUnits = snapshot?.failedUnits.data ?? [];

  const timing = snapshot?.timing.data ?? null;
  const bootTime = currentSelected ? (timing?.total ?? timing?.userspace ?? null) : null;
  const bootTimeHint = !currentSelected
    ? "systemd-analyze tracks the current boot only"
    : snapshot?.timing.error
      ? "timing not readable"
      : timing?.total
        ? "kernel plus userspace"
        : timing?.userspace
          ? "userspace only, no kernel time reported"
          : "not reported for this boot";

  const customWindow = windowCustom;

  return (
    <section className="feature-page boot-page">
      <header className="page-heading boot-heading">
        <div>
          <h2>Boot Timeline</h2>
          <p>Replay what a boot's journal recorded, at the times it happened.</p>
          <p className="boot-replay-note">
            <span>Recorded journal replay — the host is never rebooted.</span>
            <span>{currentSelected ? "Current boot" : "Historical boot"}</span>
            <span>{coverage.label}</span>
          </p>
          {snapshot && <small>Summary collected {collectedLabel(snapshot.collectedAt)}</small>}
        </div>
        <div className="boot-heading-actions">
          <label>
            <span>Boot</span>
            <select
              aria-label="Boot"
              value={snapshot?.selectedBootId ?? ""}
              disabled={loading || !boots.length}
              onChange={(event) => void collect(event.target.value)}
            >
              {boots.map((boot) => (
                <option value={boot.id} key={boot.id}>
                  {bootLabel(boot)} · {boot.range}
                </option>
              ))}
            </select>
            <small>journald reports up to 10 boots.</small>
          </label>
          <label>
            <span>Replay window</span>
            <select
              aria-label="Replay window"
              value={customWindow ? "custom" : String(windowSeconds)}
              onChange={(event) => {
                if (event.target.value === "custom") {
                  setWindowCustom(true);
                } else {
                  setWindowSeconds(normalizeWindowSeconds(Number(event.target.value)));
                  setWindowCustom(false);
                }
              }}
            >
              {BOOT_REPLAY_WINDOW_OPTIONS.map((option) => (
                <option value={option} key={option}>
                  {option >= 60
                    ? `${Math.round(option / 60)} minute${option >= 120 ? "s" : ""}`
                    : `${option} seconds`}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
            <small>
              {MIN_BOOT_REPLAY_WINDOW_SECONDS} s to{" "}
              {Math.round(MAX_BOOT_REPLAY_WINDOW_SECONDS / 60)} min.
            </small>
          </label>
          {customWindow && (
            <label className="boot-window-custom">
              <span>Custom window</span>
              <input
                type="number"
                aria-label="Custom window seconds"
                min={MIN_BOOT_REPLAY_WINDOW_SECONDS}
                max={MAX_BOOT_REPLAY_WINDOW_SECONDS}
                value={windowSeconds}
                onChange={(event) =>
                  setWindowSeconds(normalizeWindowSeconds(Number(event.target.value)))
                }
              />
              <small>seconds, clamped to the supported range</small>
            </label>
          )}
          <button
            className="secondary-button"
            type="button"
            disabled={loading}
            onClick={() => {
              clock.pause();
              void collect(snapshot?.selectedBootId ?? null);
              if (selectedBootId) void runReplay(selectedBootId, null, null);
            }}
          >
            <RefreshCw size={15} className={loading ? "spinning" : ""} /> Refresh
          </button>
        </div>
      </header>

      {error && (
        <p className="inline-warning">Showing the previous result. Refresh failed: {error}</p>
      )}
      {loading && snapshot && (
        <p className="boot-refreshing">Refreshing this boot investigation…</p>
      )}

      {snapshot && (
        <>
          {/* The three numbers worth reading first. Everything below is the
              evidence behind them, and none of it answers "how did this boot
              go?" without being read end to end. */}
          <div className="overview-stats boot-summary">
            <div className="overview-stat">
              <span className="overview-stat-label">Boot time</span>
              <strong className="overview-stat-value">{bootTime ?? "Not measured"}</strong>
              <span className="overview-stat-hint">{bootTimeHint}</span>
            </div>
            <div className="overview-stat">
              <span className="overview-stat-label">Notable issues</span>
              <strong className="overview-stat-value">{windowNotables.length}</strong>
              <span className="overview-stat-hint">
                failures and warnings in this window's loaded evidence
              </span>
            </div>
            <div className="overview-stat">
              <span className="overview-stat-label">Evidence</span>
              <strong className="overview-stat-value">{coverage.label}</strong>
              <span className="overview-stat-hint">{coverage.explanation}</span>
            </div>
          </div>

          <section className="boot-theater" aria-label="Boot replay">
            {playheadStatus && (
              <p className="boot-at-playhead" role="status">
                {playheadStatus}
              </p>
            )}
            {(replayError || replayPermission) && selectedBootId && (
              <p className="boot-inline-actions">
                {replayError && (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void runReplay(selectedBootId, evidenceRef.current, null)}
                  >
                    Retry reading the journal
                  </button>
                )}
                {replayPermission && (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setSudoOpen(true)}
                  >
                    Retry with sudo
                  </button>
                )}
              </p>
            )}
            <BootTimeline
              windowUs={windowUs}
              positionUs={clock.positionUs}
              lanes={lanes}
              selectedMarkerKey={selectedMarker?.key ?? null}
              onSeek={clock.seek}
              onSelectMarker={setSelectedMarker}
              axisRef={axisRef}
            />
            <BootTransport
              clock={clock}
              windowUs={windowUs}
              disabled={!selectedBootId || replayPermission || replayLoading}
              onPrevious={() => goToMarker(previousNotableMarker(markers, clock.positionUs))}
              onNext={() => goToMarker(nextNotableMarker(markers, clock.positionUs))}
            />
            {selectedMarker && (
              <BootEventInspector
                marker={selectedMarker}
                windowUs={windowUs}
                onClose={() => setSelectedMarker(null)}
                onOpenUnit={currentSelected && onOpenSystemd ? onOpenSystemd : undefined}
                onViewUnitJournal={
                  currentSelected ? (unit) => onViewLogs({ type: "systemd", id: unit }) : undefined
                }
              />
            )}
            {evidence && (
              <BootJournalLane
                inWindowEvents={inWindowEvents}
                untimedEvents={evidence.untimedEvents}
                positionUs={clock.positionUs}
                hasMore={hasMorePages}
                loadingMore={replayStatus.kind === "loading" && !!evidence}
                onLoadMore={() =>
                  selectedBootId && void runReplay(selectedBootId, evidenceRef.current, null)
                }
                onSeek={clock.seek}
                onSelectEvent={(event) => goToEvent(event)}
              />
            )}
          </section>

          {/* Contemporaneous diagnostics, not replay events: `systemd-analyze`
              and live unit state describe the running system now, so they stay
              a separate disclosure instead of being merged into the replay. */}
          {currentSelected && (
            <details className="boot-current-diagnostics">
              <summary>
                <span>Current-boot diagnostics</span>
                <span>systemd-analyze timing and live unit state, separate from the replay</span>
              </summary>
              <div className="boot-sections">
                <section className="boot-section">
                  <SectionHeading title="Boot timing" collectedAt={snapshot.timing.collectedAt} />
                  {snapshot.timing.error ? (
                    <SectionError section={snapshot.timing} action={sudoRetry(snapshot.timing)} />
                  ) : snapshot.timing.data ? (
                    <>
                      <dl className="boot-timing-list">
                        <div>
                          <dt>Kernel</dt>
                          <dd>{snapshot.timing.data.kernel ?? "Unavailable"}</dd>
                        </div>
                        <div>
                          <dt>Userspace</dt>
                          <dd>{snapshot.timing.data.userspace ?? "Unavailable"}</dd>
                        </div>
                      </dl>
                      <p className="boot-original">{snapshot.timing.data.original}</p>
                    </>
                  ) : (
                    <p className="boot-empty">No timing was returned for this boot.</p>
                  )}
                </section>

                <section className="boot-section">
                  <SectionHeading title="Slow units" collectedAt={snapshot.slowUnits.collectedAt} />
                  {snapshot.slowUnits.error ? (
                    <SectionError
                      section={snapshot.slowUnits}
                      action={sudoRetry(snapshot.slowUnits)}
                    />
                  ) : (
                    <>
                      <p className="boot-observation">
                        Longest activation times observed; duration alone does not establish cause.
                      </p>
                      <div className="boot-unit-list">
                        {slowUnits.map((unit) => {
                          const millis = durationToMillis(unit.duration);
                          const share =
                            millis !== null && slowest > 0 ? (millis / slowest) * 100 : null;
                          return (
                            <div key={unit.unit}>
                              {onOpenSystemd ? (
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() => onOpenSystemd(unit.unit)}
                                >
                                  {unit.unit}
                                </button>
                              ) : (
                                <span title={unit.unit}>{unit.unit}</span>
                              )}
                              <strong>{unit.duration}</strong>
                              <span className="boot-unit-track" aria-hidden="true">
                                {share !== null && (
                                  <span className="boot-unit-bar" style={{ width: `${share}%` }} />
                                )}
                              </span>
                            </div>
                          );
                        })}
                        {!slowUnits.length && <p>No slow-unit rows returned.</p>}
                      </div>
                    </>
                  )}
                </section>

                <section className="boot-section boot-section-wide">
                  <SectionHeading
                    title="Failed units"
                    collectedAt={snapshot.failedUnits.collectedAt}
                  />
                  {snapshot.failedUnits.error ? (
                    <SectionError
                      section={snapshot.failedUnits}
                      action={sudoRetry(snapshot.failedUnits)}
                    />
                  ) : failedUnits.length ? (
                    <div className="boot-failed-list">
                      {failedUnits.map((unit) => (
                        <div key={unit.id}>
                          <span>
                            {onOpenSystemd ? (
                              <button
                                type="button"
                                className="link-button"
                                onClick={() => onOpenSystemd(unit.id)}
                              >
                                {unit.id}
                              </button>
                            ) : (
                              <strong>{unit.id}</strong>
                            )}
                            <small>{unit.description || "No description"}</small>
                          </span>
                          <span>
                            {unit.activeState} / {unit.subState}
                          </span>
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => onViewLogs({ type: "systemd", id: unit.id })}
                          >
                            <FileClock size={14} /> View journal
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="boot-empty">
                      No failed units were returned for the current system scope. This is not a
                      complete health result.
                    </p>
                  )}
                </section>
              </div>
            </details>
          )}
        </>
      )}

      {sudoOpen && (
        <CredentialDialog
          connectionLabel={connection.displayName}
          onClose={() => setSudoOpen(false)}
          onSubmit={async (password) => {
            await collect(snapshotRef.current?.selectedBootId ?? null, password);
            const bootId = snapshotRef.current?.selectedBootId;
            // A permission shell loaded nothing worth resuming, so the
            // elevated retry rereads this boot from its first page.
            const prior = evidenceRef.current?.loadedCount ? evidenceRef.current : null;
            if (bootId) await runReplay(bootId, prior, password);
          }}
        />
      )}
    </section>
  );
}
