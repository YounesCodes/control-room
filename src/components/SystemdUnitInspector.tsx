import { useState } from "react";
import { FileClock, GitBranch, Network, RefreshCw, Timer } from "lucide-react";
import { InspectorDisclosure } from "./InspectorDisclosure";
import { useSystemdReads } from "../lib/systemd-inspection";
import { systemdEdges, systemdValue, systemdStateLabel } from "../lib/systemd-units";
import type { CachedValue, LogSourceSelection, SystemdInspection, SystemdUnit } from "../types";

function Fields({ rows }: { rows: [string, string | undefined][] }) {
  return (
    <dl className="detail-list">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{systemdValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function duration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unavailable";
  if (seconds >= 86400)
    return Math.floor(seconds / 86400) + "d " + Math.floor((seconds % 86400) / 3600) + "h";
  if (seconds >= 3600)
    return Math.floor(seconds / 3600) + "h " + Math.floor((seconds % 3600) / 60) + "m";
  return Math.floor(seconds / 60) + "m " + Math.floor(seconds % 60) + "s";
}

function resource(value: string | undefined, divisor: number, suffix: string) {
  if (systemdValue(value) === "Unavailable") return "Unavailable";
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? (number / divisor).toLocaleString(undefined, { maximumFractionDigits: 2 }) + suffix
    : "Unavailable";
}

function Evidence({
  connectionId,
  cacheScope,
  unit,
  section,
  revision,
}: {
  connectionId: string;
  cacheScope?: string;
  unit: string;
  section: "journal" | "configuration" | "effectiveConfiguration";
  revision: number;
}) {
  const [retry, setRetry] = useState(0);
  const result = useSystemdReads(connectionId, [unit], revision + retry, section, cacheScope)[unit];
  return (
    <>
      {result?.loading && (
        <p role="status">Reading {section === "journal" ? "journal" : "unit files"}…</p>
      )}
      {result?.error && (
        <p className="inline-warning" role="status">
          {result.value ? "Saved evidence. " : ""}
          {result.error}{" "}
          <button type="button" className="link-button" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </p>
      )}
      {result?.value?.warnings.map((warning) => (
        <p className="inline-warning" key={warning}>
          {warning}
        </p>
      ))}
      {result?.value?.truncated && <p className="inline-warning">Showing the first 128 KiB.</p>}
      {result?.value && (
        <pre className="systemd-evidence" tabIndex={0}>
          {result.value.text ||
            (section === "journal"
              ? "No journal entries visible to this account."
              : "No unit files returned.")}
        </pre>
      )}
    </>
  );
}

export function SystemdUnitInspector({
  connectionId,
  cacheScope,
  unitId,
  summary,
  result,
  revision,
  onRefresh,
  onNavigate,
  onExplore,
  onViewLogs,
  onOpenPorts,
  onOpenBoot,
}: {
  connectionId: string;
  cacheScope?: string;
  unitId: string;
  summary: SystemdUnit | null;
  result?: CachedValue<SystemdInspection>;
  revision: number;
  onRefresh: () => void;
  onNavigate: (id: string) => void;
  onExplore?: () => void;
  onViewLogs: (source: LogSourceSelection) => void;
  onOpenPorts?: (unit: string) => void;
  onOpenBoot?: () => void;
}) {
  const [configuration, setConfiguration] = useState(false);
  const [effective, setEffective] = useState(false);
  const [journal, setJournal] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const p = result?.value?.properties ?? {};
  const type = unitId.split(".").at(-1);
  const active = p.ActiveState ?? summary?.activeState;
  const sub = p.SubState ?? summary?.subState;
  const failed = active === "failed";
  const uptime =
    active === "active" && p.ActiveEnterTimestamp && p.ControlRoomRealtimeSeconds
      ? duration(Number(p.ControlRoomRealtimeSeconds) - Date.parse(p.ActiveEnterTimestamp) / 1000)
      : undefined;
  const edges = result?.value ? systemdEdges([result.value]) : [];
  const code = p.ExecMainCode;
  const execution =
    code === "1"
      ? "Exited"
      : code === "2"
        ? "Killed by signal"
        : code === "3"
          ? "Core dumped"
          : code === "0"
            ? "Not recorded"
            : code;
  const related = new Map<string, string[]>();
  for (const edge of edges) {
    const outgoing = edge.source === unitId;
    const id = outgoing ? edge.target : edge.source;
    const label = outgoing
      ? edge.relationship
      : edge.relationship === "Requires"
        ? "Required by"
        : edge.relationship === "Wants"
          ? "Wanted by"
          : edge.relationship === "Triggers"
            ? "Triggered by"
            : edge.relationship === "After"
              ? "Before"
              : "After";
    related.set(id, [...(related.get(id) ?? []), label]);
  }
  const essentials: [string, string | undefined][] =
    type === "service"
      ? [
          ...(!failed
            ? [
                ["Main PID", p.MainPID === "0" ? "Not assigned" : p.MainPID] as [
                  string,
                  string | undefined,
                ],
                ["Uptime", uptime] as [string, string | undefined],
              ]
            : []),
          ...(p.MemoryCurrent && systemdValue(p.MemoryCurrent) !== "Unavailable"
            ? [["Memory", resource(p.MemoryCurrent, 1048576, " MiB")] as [string, string]]
            : []),
        ]
      : type === "timer"
        ? [
            ["Next trigger", p.NextElapseUSecRealtime],
            ["Last trigger", p.LastTriggerUSec],
            ["Associated unit", p.Unit],
          ]
        : type === "socket"
          ? [
              ["Listening", p.Listen],
              ["Activates", p.Triggers],
            ]
          : type === "mount"
            ? [
                ["Mount point", p.Where],
                ["Source", p.What],
                ["Filesystem", p.Type],
              ]
            : [];
  const runtime: [string, string | undefined][] =
    type === "service"
      ? [
          ["Service type", p.Type],
          ["Control PID", p.ControlPID === "0" ? undefined : p.ControlPID],
          ["Started", p.ExecMainStartTimestamp],
          ["Last exit", p.ExecMainExitTimestamp],
          ["Restart policy", p.Restart],
          ["Restarts", p.NRestarts],
          ["CPU time", p.CPUUsageNSec ? resource(p.CPUUsageNSec, 1e9, " s") : undefined],
          ["Tasks", p.TasksCurrent],
          ["ExecStart", p.ExecStart],
        ]
      : type === "timer"
        ? [
            ["Calendar", p.TimersCalendar],
            ["Monotonic schedule", p.TimersMonotonic],
            ["Next monotonic", p.NextElapseUSecMonotonic],
          ]
        : type === "socket"
          ? [
              ["Accept", p.Accept],
              ["Accepted", p.NAccepted],
              ["Connections", p.NConnections],
              ["Activated by", p.TriggeredBy],
            ]
          : type === "mount"
            ? [["Options", p.Options]]
            : [];
  return (
    <>
      <header>
        <h2>{unitId}</h2>
        <p>{p.Description ?? summary?.description}</p>
        <span className="systemd-inspector-state">
          <span
            className={"service-indicator service-" + (active ?? "unknown")}
            aria-hidden="true"
          />
          {systemdStateLabel(active, sub)}
        </span>
      </header>
      <div className="port-inspector-body">
        {result?.loading && (
          <p className="systemd-read-status" role="status">
            {result.value ? "Refreshing saved details…" : "Reading unit details…"}
          </p>
        )}
        {result?.error && (
          <p className="inline-warning" role="status">
            {result.value ? "Showing saved details. " : "Details unavailable. "}
            {result.error}
          </p>
        )}
        {result?.value?.warnings.map((warning) => (
          <p className="inline-warning" key={warning}>
            {warning}
          </p>
        ))}
        {result?.value?.truncated && (
          <p className="inline-warning">
            Details truncated at 128 KiB. Some relationships may be missing.
          </p>
        )}
        {failed && (
          <section className="systemd-failure-evidence">
            <h3>Failure evidence</h3>
            <Fields
              rows={[
                ["Result", p.Result],
                [
                  code === "2" || code === "3" ? "Signal" : "Exit status",
                  code && code !== "0" ? p.ExecMainStatus : undefined,
                ],
              ]}
            />
          </section>
        )}
        {!!essentials.length && <Fields rows={essentials} />}
        <InspectorDisclosure title="Dependencies">
          <button
            type="button"
            className="link-button"
            onClick={onExplore ?? (() => onNavigate(unitId))}
          >
            Explore dependencies
          </button>
          {related.size ? (
            <div className="systemd-related">
              {[...related].map(([id, labels]) => (
                <button
                  type="button"
                  className="systemd-related-unit"
                  key={id}
                  onClick={() => onNavigate(id)}
                >
                  <span>
                    <strong>{id}</strong>
                    <small>{[...new Set(labels)].join(" · ")}</small>
                  </span>
                  <GitBranch size={13} />
                </button>
              ))}
            </div>
          ) : (
            <p className="systemd-evidence-note">
              {result?.value
                ? "No dependency evidence returned."
                : "Dependency evidence unavailable."}
            </p>
          )}
        </InspectorDisclosure>
        <InspectorDisclosure title="Recent journal" open={journal} onToggle={setJournal}>
          {journal && (
            <Evidence
              connectionId={connectionId}
              cacheScope={cacheScope}
              unit={unitId}
              section="journal"
              revision={revision}
            />
          )}
        </InspectorDisclosure>
        <InspectorDisclosure
          title="Advanced"
          onToggle={(open) => {
            setAdvanced(open);
            if (!open) {
              setConfiguration(false);
              setEffective(false);
            }
          }}
        >
          {advanced && (
            <>
              <Fields
                rows={[
                  ["Substate", sub],
                  ["Load state", p.LoadState ?? summary?.loadState],
                  ["Enablement", p.UnitFileState ?? summary?.unitFileState ?? undefined],
                  ...(!failed
                    ? [
                        ["Systemd result", p.Result] as [string, string | undefined],
                        ["Exit status", code && code !== "0" ? p.ExecMainStatus : undefined] as [
                          string,
                          string | undefined,
                        ],
                      ]
                    : []),
                  ["Execution result", execution],
                  ["Status", p.StatusText],
                  ["Condition passed", p.ConditionResult],
                  ["Assertion passed", p.AssertResult],
                  ...runtime,
                ].filter((row): row is [string, string] => row[1] !== undefined)}
              />
              <InspectorDisclosure title="Configuration" onToggle={setConfiguration}>
                <Fields
                  rows={[
                    ["Unit file", p.FragmentPath],
                    ["Source file", p.SourcePath],
                    ["Drop-ins", p.DropInPaths === "" ? "None reported" : p.DropInPaths],
                    ["Reload needed", p.NeedDaemonReload],
                  ]}
                />
                {configuration && (
                  <>
                    <p className="systemd-evidence-note">
                      Files on disk may differ from loaded properties until a daemon reload.
                    </p>
                    <Evidence
                      connectionId={connectionId}
                      cacheScope={cacheScope}
                      unit={unitId}
                      section="configuration"
                      revision={revision}
                    />
                  </>
                )}
              </InspectorDisclosure>
              <InspectorDisclosure title="Effective properties" onToggle={setEffective}>
                {effective && (
                  <Evidence
                    connectionId={connectionId}
                    cacheScope={cacheScope}
                    unit={unitId}
                    section="effectiveConfiguration"
                    revision={revision}
                  />
                )}
              </InspectorDisclosure>
              <div className="systemd-inspector-links">
                {onOpenPorts && (
                  <button type="button" className="link-button" onClick={() => onOpenPorts(unitId)}>
                    <Network size={13} />
                    Ports
                  </button>
                )}
                {onOpenBoot && (
                  <button type="button" className="link-button" onClick={onOpenBoot}>
                    <Timer size={13} />
                    Boot
                  </button>
                )}
              </div>
              {result?.value && (
                <p className="systemd-evidence-note">
                  Collected {new Date(result.value.collectedAt).toLocaleTimeString()}
                </p>
              )}
            </>
          )}
        </InspectorDisclosure>
      </div>
      <div className="detail-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => onViewLogs({ type: "systemd", id: unitId })}
        >
          <FileClock size={14} />
          View journal
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={onExplore ?? (() => onNavigate(unitId))}
        >
          <GitBranch size={14} />
          Graph
        </button>
        <button
          type="button"
          className="icon-button"
          title="Refresh unit details"
          aria-label="Refresh unit details"
          onClick={onRefresh}
          disabled={result?.loading}
        >
          <RefreshCw size={14} />
        </button>
      </div>
    </>
  );
}
