import { useEffect, useRef, useState } from "react";
import { AlertCircle, FileClock, RefreshCw } from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import type { BootDiagnostics, BootSection, LogSourceSelection, SavedConnection } from "../types";

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

  return (
    <section className="feature-page boot-page">
      <header className="page-heading boot-heading">
        <div>
          <h2>Boot Diagnostics</h2>
          <p>Bounded observations from systemd and the journal</p>
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
                  {boot.current ? "Current boot" : `Previous boot ${boot.index}`} · {boot.range}
                </option>
              ))}
            </select>
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
      {loading && snapshot && <p className="inline-warning">Refreshing this boot investigation…</p>}

      {snapshot && (
        <div className="boot-sections">
          <section className="boot-section boot-section-wide boot-source-section">
            <SectionHeading title="Available boots" collectedAt={snapshot.boots.collectedAt} />
            {snapshot.boots.error ? (
              <SectionError section={snapshot.boots} />
            ) : (
              <p>
                Showing up to 10 boots reported by journald. Selected:{" "}
                {selectedBoot?.range ?? "current boot"}.
              </p>
            )}
          </section>

          <section className="boot-section">
            <SectionHeading title="Boot timing" collectedAt={snapshot.timing.collectedAt} />
            {snapshot.timing.error ? (
              <SectionError section={snapshot.timing} />
            ) : snapshot.timing.data ? (
              <>
                <dl className="boot-timing-list">
                  <div>
                    <dt>Total</dt>
                    <dd>{snapshot.timing.data.total ?? "Unavailable"}</dd>
                  </div>
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
            ) : null}
          </section>

          <section className="boot-section">
            <SectionHeading title="Slow units" collectedAt={snapshot.slowUnits.collectedAt} />
            {snapshot.slowUnits.error ? (
              <SectionError section={snapshot.slowUnits} />
            ) : (
              <>
                <p className="boot-observation">
                  Longest activation times observed; duration alone does not establish cause.
                </p>
                <div className="boot-unit-list">
                  {snapshot.slowUnits.data?.map((unit) => (
                    <div key={unit.unit}>
                      <span>{unit.unit}</span>
                      <strong>{unit.duration}</strong>
                    </div>
                  ))}
                  {!snapshot.slowUnits.data?.length && <p>No slow-unit rows returned.</p>}
                </div>
              </>
            )}
          </section>

          <section className="boot-section boot-section-wide">
            <SectionHeading title="Failed units" collectedAt={snapshot.failedUnits.collectedAt} />
            {snapshot.failedUnits.error ? (
              <SectionError section={snapshot.failedUnits} />
            ) : snapshot.failedUnits.data?.length ? (
              <div className="boot-failed-list">
                {snapshot.failedUnits.data.map((unit) => (
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
              <SectionError
                section={snapshot.journal}
                action={
                  snapshot.journal.permissionRequired ? (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => setSudoOpen(true)}
                    >
                      Retry with sudo
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <p className="boot-observation">
                  Up to 30 warning-through-alert journal entries; no full boot log is loaded.
                </p>
                <pre className="boot-journal-sample">
                  {snapshot.journal.data?.length
                    ? snapshot.journal.data.join("\n")
                    : "No warning or error entries returned."}
                </pre>
              </>
            )}
          </section>
        </div>
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
