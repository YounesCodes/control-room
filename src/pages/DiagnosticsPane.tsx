import { useCallback, useEffect, useRef, useState } from "react";
import { FileClock, RefreshCw, SquareTerminal, X } from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import {
  DEFAULT_JOURNAL_LINES,
  DIAGNOSTIC_SECTIONS,
  EVIDENCE_NOTICE,
  JOURNAL_LINE_OPTIONS,
  applicableSections,
  dependencySummary,
  exitDetails,
  formatCollectedAt,
  isPermissionDenied,
  listenerHeadline,
  oneShotNotice,
  sectionTitle,
  stateHeadline,
  statusLabel,
} from "../lib/service-diagnostics";
import type {
  CachedList,
  DiagnosticSectionKind,
  LogSourceSelection,
  SavedConnection,
  ServiceDiagnosticSection,
  SystemdUnit,
} from "../types";

const CANCELLED_MESSAGE = "Section collection was cancelled.";

interface SectionState {
  status: "idle" | "running" | "ready" | "error";
  section: ServiceDiagnosticSection | null;
  error: string | null;
  operationId: string | null;
}

const idleSection: SectionState = {
  status: "idle",
  section: null,
  error: null,
  operationId: null,
};

function emptySections(): Record<DiagnosticSectionKind, SectionState> {
  return {
    state: idleSection,
    journal: idleSection,
    dependencies: idleSection,
    listeners: idleSection,
  };
}

export function DiagnosticsPane({
  connection,
  servicesCache,
  onServicesCacheChange,
  unitId,
  onUnitChange,
  onViewLogs,
  onPaste,
  canPaste,
}: {
  connection: SavedConnection;
  servicesCache: CachedList<SystemdUnit>;
  onServicesCacheChange: (cache: CachedList<SystemdUnit>) => void;
  unitId: string | null;
  onUnitChange: (unitId: string | null) => void;
  onViewLogs: (source: LogSourceSelection) => void;
  onPaste: (command: string) => void;
  canPaste: boolean;
}) {
  const [sections, setSections] = useState(emptySections);
  const [journalLines, setJournalLines] = useState(DEFAULT_JOURNAL_LINES);
  const [sudoSection, setSudoSection] = useState<DiagnosticSectionKind | null>(null);
  const [unitsError, setUnitsError] = useState<string | null>(null);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const cacheRef = useRef(servicesCache);
  const journalLinesRef = useRef(journalLines);
  cacheRef.current = servicesCache;
  journalLinesRef.current = journalLines;

  useEffect(() => {
    if (cacheRef.current.items.length) return;
    setUnitsLoading(true);
    let active = true;
    void api
      .listServices(connection.id)
      .then((items) => {
        if (!active) return;
        onServicesCacheChange({ items, fetchedAt: Date.now(), loading: false, error: null });
      })
      .catch((caught) => {
        if (active) setUnitsError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setUnitsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [connection.id]);

  const runSection = useCallback(
    async (kind: DiagnosticSectionKind, unit: string, sudoPassword: string | null = null) => {
      const operationId = crypto.randomUUID();
      setSections((current) => ({
        ...current,
        [kind]: { status: "running", section: null, error: null, operationId },
      }));
      try {
        const section = await api.collectServiceDiagnostic({
          connectionId: connection.id,
          unit,
          kind,
          operationId,
          journalLines: kind === "journal" ? journalLinesRef.current : null,
          sudoPassword,
        });
        setSections((current) =>
          current[kind].operationId === operationId
            ? { ...current, [kind]: { status: "ready", section, error: null, operationId: null } }
            : current,
        );
      } catch (caught) {
        const message = errorMessage(caught);
        setSections((current) => {
          if (current[kind].operationId !== operationId) return current;
          if (message === CANCELLED_MESSAGE) return { ...current, [kind]: idleSection };
          return {
            ...current,
            [kind]: { status: "error", section: null, error: message, operationId: null },
          };
        });
      }
    },
    [connection.id],
  );

  const cancelSection = useCallback((kind: DiagnosticSectionKind) => {
    setSections((current) => {
      const operationId = current[kind].operationId;
      if (operationId) void api.cancelServiceDiagnostic(operationId).catch(() => undefined);
      return { ...current, [kind]: idleSection };
    });
  }, []);

  // Sections run one after another so a single unit never exceeds the per-host
  // structured-operation limit, and an early failure never blocks a later
  // section.
  const runAll = useCallback(
    async (unit: string) => {
      for (const kind of applicableSections(unit)) {
        await runSection(kind, unit);
      }
    },
    [runSection],
  );

  useEffect(() => {
    setSections(emptySections());
    if (unitId) void runAll(unitId);
  }, [unitId, runAll]);

  const units = servicesCache.items;
  const selected = units.find((unit) => unit.id === unitId) ?? null;

  if (unitsLoading && !units.length) return <LoadingState label="Reading systemd units…" />;
  if (unitsError && !units.length) return <ErrorState message={unitsError} />;

  const applicable = unitId ? applicableSections(unitId) : [];

  return (
    <section className="feature-page diagnostics-page">
      <header className="page-heading">
        <div>
          <h2>Service diagnostics</h2>
          <p>{EVIDENCE_NOTICE}</p>
        </div>
        {unitId && (
          <button
            className="icon-button"
            type="button"
            onClick={() => void runAll(unitId)}
            aria-label="Refresh every applicable section"
          >
            <RefreshCw size={16} />
          </button>
        )}
      </header>

      <div className="diagnostics-controls">
        <label>
          <span>Unit</span>
          <select
            value={unitId ?? ""}
            onChange={(event) => onUnitChange(event.target.value || null)}
          >
            <option value="">Select a unit</option>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.id} · {unit.activeState}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Journal entries</span>
          <select
            value={journalLines}
            onChange={(event) => {
              const lines = Number(event.target.value);
              setJournalLines(lines);
              journalLinesRef.current = lines;
              if (unitId && sections.journal.status === "ready") void runSection("journal", unitId);
            }}
          >
            {JOURNAL_LINE_OPTIONS.map((lines) => (
              <option key={lines} value={lines}>
                {lines}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!unitId && (
        <EmptyState title="No unit selected">
          Pick a unit, or open Diagnostics from the Systemd view.
        </EmptyState>
      )}

      {unitId && (
        <div className="diagnostics-sections">
          {DIAGNOSTIC_SECTIONS.map((kind) => {
            const state = sections[kind];
            const permission = state.error ? isPermissionDenied(state.error) : false;
            return (
              <article className="diagnostics-section" key={kind}>
                <header>
                  <h3>{sectionTitle(kind)}</h3>
                  <div className="diagnostics-section-actions">
                    {state.section && (
                      <span
                        className={`diagnostics-status diagnostics-status-${state.section.status}`}
                      >
                        {statusLabel(state.section)}
                      </span>
                    )}
                    {state.status === "running" ? (
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => cancelSection(kind)}
                        aria-label={`Cancel ${sectionTitle(kind)}`}
                      >
                        <X size={15} />
                      </button>
                    ) : (
                      <button
                        className="icon-button"
                        type="button"
                        disabled={!applicable.includes(kind)}
                        onClick={() => void runSection(kind, unitId)}
                        aria-label={`Refresh ${sectionTitle(kind)}`}
                      >
                        <RefreshCw size={15} />
                      </button>
                    )}
                  </div>
                </header>

                {state.section && (
                  <p className="diagnostics-provenance">
                    {state.section.source} · read at {formatCollectedAt(state.section.collectedAt)}
                  </p>
                )}
                {state.status === "running" && <LoadingState label="Reading…" />}
                {state.status === "idle" && !applicable.includes(kind) && (
                  <p className="diagnostics-note">This section does not apply to this unit type.</p>
                )}
                {state.status === "idle" && applicable.includes(kind) && (
                  <p className="diagnostics-note">Not collected. Refresh to read it.</p>
                )}
                {state.status === "error" && state.error && (
                  <div className="diagnostics-failure">
                    <p className="inline-warning">{state.error}</p>
                    {permission && (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => setSudoSection(kind)}
                      >
                        Retry with sudo
                      </button>
                    )}
                  </div>
                )}
                {state.section?.note && <p className="diagnostics-note">{state.section.note}</p>}
                {state.section && <SectionBody section={state.section} onViewLogs={onViewLogs} />}
              </article>
            );
          })}
        </div>
      )}

      {unitId && (
        <footer className="diagnostics-footer">
          <button
            className="secondary-button"
            type="button"
            disabled={!canPaste}
            onClick={() => onPaste(`systemctl status ${unitId}`)}
          >
            <SquareTerminal size={15} /> Put systemctl status in the terminal
          </button>
          <small>
            {canPaste
              ? "The command is typed for you and waits for Enter. Control Room never runs it."
              : "Reconnect the Terminal Session to use this."}
          </small>
          {selected && <small>{selected.description || "No description"}</small>}
        </footer>
      )}

      {sudoSection && unitId && (
        <CredentialDialog
          connectionLabel={connection.displayName}
          onClose={() => setSudoSection(null)}
          onSubmit={async (password) => {
            const kind = sudoSection;
            setSudoSection(null);
            await runSection(kind, unitId, password);
          }}
        />
      )}
    </section>
  );
}

function SectionBody({
  section,
  onViewLogs,
}: {
  section: ServiceDiagnosticSection;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  if (section.state) {
    const state = section.state;
    const oneShot = oneShotNotice(state);
    return (
      <>
        <p className="diagnostics-headline">{stateHeadline(state)}</p>
        {oneShot && <p className="diagnostics-note">{oneShot}</p>}
        <ul className="diagnostics-facts">
          {exitDetails(state).map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
        <dl className="detail-list">
          <div>
            <dt>Load state</dt>
            <dd>{state.loadState ?? "Not reported"}</dd>
          </div>
          <div>
            <dt>Unit-file state</dt>
            <dd>{state.unitFileState ?? "Not reported"}</dd>
          </div>
          <div>
            <dt>Service type</dt>
            <dd>{state.unitType ?? "Not reported"}</dd>
          </div>
          <div>
            <dt>Last state change</dt>
            <dd>{state.stateChangeTimestamp ?? "Not reported"}</dd>
          </div>
          <div>
            <dt>Unit file</dt>
            <dd>{state.fragmentPath ?? "Not reported"}</dd>
          </div>
        </dl>
      </>
    );
  }

  if (section.journal) {
    const journal = section.journal;
    if (journal.empty) return null;
    return (
      <>
        <pre className="diagnostics-journal">
          {journal.lines.map((line, index) => (
            <span key={`${index}-${line.slice(0, 24)}`}>{line}</span>
          ))}
        </pre>
        <button
          className="secondary-button"
          type="button"
          onClick={() => onViewLogs({ type: "systemd", id: section.unit })}
        >
          <FileClock size={15} /> Follow this unit in Logs
        </button>
      </>
    );
  }

  if (section.dependencies) {
    const facts = section.dependencies;
    return (
      <>
        <p className="diagnostics-headline">{dependencySummary(section)}</p>
        {facts.relations.map((relation) => (
          <div className="diagnostics-relation" key={relation.kind}>
            <h4>{relation.kind}</h4>
            <ul>
              {relation.units.map((unit) => (
                <li key={unit.id}>
                  <span>{unit.id}</span>
                  <small>
                    {unit.activeState
                      ? `${unit.activeState}${unit.subState ? ` (${unit.subState})` : ""}`
                      : "state not read"}
                  </small>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </>
    );
  }

  if (section.listeners) {
    const evidence = section.listeners;
    return (
      <>
        <p className="diagnostics-headline">{listenerHeadline(evidence, section.unit)}</p>
        {Boolean(evidence.sockets.length) && (
          <ul className="diagnostics-facts">
            {evidence.sockets.map((socket) => (
              <li key={socket.id}>
                {socket.protocol.toUpperCase()} {socket.localAddress}:{socket.port} ·{" "}
                {socket.processName ?? "process not reported"}
              </li>
            ))}
          </ul>
        )}
        <small className="diagnostics-note">
          {evidence.totalListeners} listeners were read on this host.
        </small>
      </>
    );
  }

  return null;
}
