import { useEffect, useRef, useState } from "react";
import { AlertCircle, FileClock, RefreshCw } from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import { bootLabel, durationToMillis, sampleHint, splitJournalLine } from "../lib/boot-diagnostics";
import type { BootDiagnostics, BootSection, LogSourceSelection, SavedConnection } from "../types";

const JOURNAL_CAP = 30;

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
}: {
  connection: SavedConnection;
  snapshot: BootDiagnostics | null;
  onSnapshotChange: (snapshot: BootDiagnostics) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sudoOpen, setSudoOpen] = useState(false);
  const requestRef = useRef(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

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

  useEffect(() => {
    void collect();
    return () => {
      requestRef.current += 1;
    };
  }, [connection.id]);

  if (loading && !snapshot) return <LoadingState label="Inspecting the current boot…" />;
  if (error && !snapshot) {
    return (
      <ErrorState message={error} action={<button onClick={() => void collect()}>Retry</button>} />
    );
  }

  const boots = snapshot?.boots.data ?? [];
  const selectedBoot = boots.find((boot) => boot.id === snapshot?.selectedBootId) ?? null;
  const currentSelected = selectedBoot?.current ?? snapshot?.selectedBootId === null;

  // A section may be refused for permission rather than be missing, and any of
  // them can be. The retry is offered wherever Rust reports that, not only on
  // the journal, so the one section that needs root is never a dead end.
  const sudoRetry = (section: BootSection<unknown>) =>
    section.permissionRequired ? (
      <button className="secondary-button" type="button" onClick={() => setSudoOpen(true)}>
        Retry with sudo
      </button>
    ) : undefined;

  const slowUnits = snapshot?.slowUnits.data ?? [];
  // Bars are drawn against the longest row on screen, so the comparison is
  // between the units listed and nothing wider is implied.
  const slowest = slowUnits.reduce((longest, unit) => {
    const millis = durationToMillis(unit.duration);
    return millis !== null && millis > longest ? millis : longest;
  }, 0);

  const failedUnits = snapshot?.failedUnits.data ?? [];
  const journalLines = snapshot?.journal.data ?? [];

  // Hosts that cannot measure kernel time report only a userspace figure, and
  // systemd prints no total at all. Calling that "Unavailable" hides a number
  // the card below is already showing, so it falls back and says which it is.
  const timing = snapshot?.timing.data ?? null;
  const bootTime = timing?.total ?? timing?.userspace ?? null;
  const bootTimeHint = snapshot?.timing.error
    ? "timing not readable"
    : timing?.total
      ? "kernel plus userspace"
      : timing?.userspace
        ? "userspace only, no kernel time reported"
        : "not reported for this boot";

  return (
    <section className="feature-page boot-page">
      <header className="page-heading boot-heading">
        <div>
          <h2>Boot Diagnostics</h2>
          <p>How long this boot took, which units failed, and what the journal warned about.</p>
          {snapshot && (
            <small>Investigation collected {collectedLabel(snapshot.collectedAt)}</small>
          )}
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
          <button
            className="secondary-button"
            type="button"
            disabled={loading}
            onClick={() => void collect(snapshot?.selectedBootId ?? null)}
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
              <strong className="overview-stat-value">{bootTime ?? "Unavailable"}</strong>
              <span className="overview-stat-hint">{bootTimeHint}</span>
            </div>
            <div className="overview-stat">
              <span className="overview-stat-label">Units failed</span>
              <strong className="overview-stat-value">
                {snapshot.failedUnits.error ? "Unavailable" : failedUnits.length}
              </strong>
              <span className="overview-stat-hint">
                {snapshot.failedUnits.error ? "not readable" : "system scope, not a health result"}
              </span>
            </div>
            <div className="overview-stat">
              <span className="overview-stat-label">Journal warnings</span>
              <strong className="overview-stat-value">
                {snapshot.journal.error ? "Unavailable" : journalLines.length}
              </strong>
              <span className="overview-stat-hint">
                {snapshot.journal.error
                  ? "not readable"
                  : sampleHint(journalLines.length, JOURNAL_CAP)}
              </span>
            </div>
          </div>

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
                <SectionError section={snapshot.slowUnits} action={sudoRetry(snapshot.slowUnits)} />
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
                          <span title={unit.unit}>{unit.unit}</span>
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
              <SectionHeading title="Failed units" collectedAt={snapshot.failedUnits.collectedAt} />
              {snapshot.failedUnits.error ? (
                <SectionError
                  section={snapshot.failedUnits}
                  action={sudoRetry(snapshot.failedUnits)}
                />
              ) : failedUnits.length ? (
                <>
                  <div className="boot-failed-list">
                    {failedUnits.map((unit) => (
                      <div key={unit.id}>
                        <span>
                          <strong>{unit.id}</strong>
                          <small>{unit.description || "No description"}</small>
                        </span>
                        <span>
                          {unit.activeState} / {unit.subState}
                        </span>
                        {currentSelected && (
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => onViewLogs({ type: "systemd", id: unit.id })}
                          >
                            <FileClock size={14} /> View journal
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {/* The button vanishing on an older boot looks like a bug
                      unless the reason is written down. */}
                  {!currentSelected && (
                    <p className="boot-observation">
                      Unit journals are read live, so they are offered for the current boot only.
                    </p>
                  )}
                </>
              ) : (
                <p className="boot-empty">
                  No failed units were returned for the current system scope. This is not a complete
                  health result.
                </p>
              )}
            </section>

            <section className="boot-section boot-section-wide">
              <SectionHeading
                title="Warning and error sample"
                collectedAt={snapshot.journal.collectedAt}
              />
              {snapshot.journal.error ? (
                <SectionError section={snapshot.journal} action={sudoRetry(snapshot.journal)} />
              ) : (
                <>
                  <p className="boot-observation">
                    Up to {JOURNAL_CAP} warning-through-alert journal entries; no full boot log is
                    loaded.
                  </p>
                  {journalLines.length ? (
                    <ol className="boot-journal-sample">
                      {journalLines.map((line, index) => {
                        const entry = splitJournalLine(line);
                        return (
                          <li key={`${index}-${line}`}>
                            {entry.time && (
                              <time dateTime={entry.timestamp ?? undefined}>{entry.time}</time>
                            )}
                            <span>{entry.message}</span>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className="boot-empty">No warning or error entries returned.</p>
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}

      {sudoOpen && (
        <CredentialDialog
          connectionLabel={connection.displayName}
          onClose={() => setSudoOpen(false)}
          onSubmit={(password) => collect(snapshotRef.current?.selectedBootId ?? null, password)}
        />
      )}
    </section>
  );
}
