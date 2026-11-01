import { useState } from "react";
import { FileClock, GitBranch, Network, RefreshCw, Timer } from "lucide-react";
import { InspectorDisclosure } from "./InspectorDisclosure";
import { LoadingState } from "./PanelState";
import { useSystemdReads } from "../lib/systemd-inspection";
import { systemdEdges, systemdValue } from "../lib/systemd-units";
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
  onViewLogs: (source: LogSourceSelection) => void;
  onOpenPorts?: (unit: string) => void;
  onOpenBoot?: () => void;
}) {
  const [configuration, setConfiguration] = useState(false);
  const [effective, setEffective] = useState(false);
  const [journal, setJournal] = useState(false);
  const p = result?.value?.properties ?? {};
  const type = unitId.split(".").at(-1);
  const active = p.ActiveState ?? summary?.activeState;
  const failed = active === "failed";
  const uptime =
    active === "active" && p.ActiveEnterTimestamp && p.ControlRoomRealtimeSeconds
      ? duration(Number(p.ControlRoomRealtimeSeconds) - Date.parse(p.ActiveEnterTimestamp) / 1000)
      : "Unavailable";
  const edges = result?.value ? systemdEdges([result.value]) : [];
  const code = p.ExecMainCode;
  const exitCode =
    code === "1"
      ? "Exited"
      : code === "2"
        ? "Killed by signal"
        : code === "3"
          ? "Core dumped"
          : code === "0"
            ? "Not recorded"
            : code;
  return (
    <>
      <header>
        <h2>{unitId}</h2>
        <p>{p.Description ?? summary?.description ?? "Unit details"}</p>
      </header>
      <div className="port-inspector-body">
        {result?.loading && !result.value && <LoadingState label="Reading unit details…" />}
        {result?.loading && result.value && (
          <p role="status">Showing saved details while refreshing…</p>
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
        <Fields
          rows={[
            ["State", [active, p.SubState ?? summary?.subState].filter(Boolean).join(" / ")],
            ["Load state", p.LoadState ?? summary?.loadState],
            ["Enablement", p.UnitFileState ?? summary?.unitFileState ?? undefined],
          ]}
        />
        <InspectorDisclosure title={failed ? "Failure evidence" : "Lifecycle"} open>
          <Fields
            rows={[
              ["Systemd result", p.Result],
              ["Execution result", exitCode],
              [
                code === "2" || code === "3" ? "Signal" : "Exit status",
                code && code !== "0" ? p.ExecMainStatus : undefined,
              ],
              ...(p.StatusText ? [["Status", p.StatusText] as [string, string]] : []),
              ...(p.ConditionResult
                ? [["Condition passed", p.ConditionResult] as [string, string]]
                : []),
              ...(p.AssertResult ? [["Assertion passed", p.AssertResult] as [string, string]] : []),
            ]}
          />
          {failed && (
            <button className="link-button" type="button" onClick={() => setJournal(true)}>
              Show failure journal
            </button>
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
        {type === "service" && (
          <InspectorDisclosure title="Service" open={!failed}>
            <Fields
              rows={[
                ["Service type", p.Type],
                ["Main PID", p.MainPID === "0" ? "Not assigned" : p.MainPID],
                ...(p.ControlPID && p.ControlPID !== "0"
                  ? [["Control PID", p.ControlPID] as [string, string]]
                  : []),
                ["Uptime", uptime],
                ["Started", p.ExecMainStartTimestamp],
                ["Last exit", p.ExecMainExitTimestamp],
                ["Restart policy", p.Restart],
                ["Restarts", p.NRestarts],
                ["Memory", resource(p.MemoryCurrent, 1048576, " MiB")],
                ["CPU time", resource(p.CPUUsageNSec, 1e9, " s")],
                ["Tasks", p.TasksCurrent],
                ["ExecStart", p.ExecStart],
              ]}
            />
          </InspectorDisclosure>
        )}
        {type === "timer" && (
          <InspectorDisclosure title="Timer" open>
            <Fields
              rows={[
                ["Next trigger", p.NextElapseUSecRealtime],
                [
                  "Next monotonic",
                  p.NextElapseUSecMonotonic === "0"
                    ? "Not scheduled"
                    : p.NextElapseUSecMonotonic &&
                        systemdValue(p.NextElapseUSecMonotonic) !== "Unavailable"
                      ? p.NextElapseUSecMonotonic + " since boot"
                      : undefined,
                ],
                ["Last trigger", p.LastTriggerUSec],
                ["Calendar", p.TimersCalendar],
                ["Monotonic schedule", p.TimersMonotonic],
                ["Associated unit", p.Unit],
              ]}
            />
          </InspectorDisclosure>
        )}
        {type === "socket" && (
          <InspectorDisclosure title="Socket" open>
            <Fields
              rows={[
                ["Listening", p.Listen],
                ["Accept", p.Accept],
                ["Accepted", p.NAccepted],
                ["Connections", p.NConnections],
                ["Triggers", p.Triggers],
                ["Activated by", p.TriggeredBy],
              ]}
            />
          </InspectorDisclosure>
        )}
        {type === "mount" && (
          <InspectorDisclosure title="Mount" open>
            <Fields
              rows={[
                ["Mount point", p.Where],
                ["Source", p.What],
                ["Filesystem", p.Type],
                ["Options", p.Options],
              ]}
            />
          </InspectorDisclosure>
        )}
        <InspectorDisclosure title={"Dependencies · " + edges.length} open={failed}>
          <p className="systemd-evidence-note">
            Requires and Wants pull in units. After and Before only order them.
          </p>
          {edges.length ? (
            <div className="systemd-related">
              {edges.map((edge) => {
                const outgoing = edge.source === unitId;
                const neighbor = outgoing ? edge.target : edge.source;
                return (
                  <button
                    type="button"
                    className="systemd-related-unit"
                    key={edge.id}
                    onClick={() => onNavigate(neighbor)}
                  >
                    <span>
                      {outgoing
                        ? edge.relationship
                        : edge.relationship === "Requires"
                          ? "Required by"
                          : edge.relationship === "Wants"
                            ? "Wanted by"
                            : edge.relationship === "Triggers"
                              ? "Triggered by"
                              : edge.relationship === "After"
                                ? "Before"
                                : "After"}
                    </span>{" "}
                    <strong>{neighbor}</strong>
                    <GitBranch size={13} />
                  </button>
                );
              })}
            </div>
          ) : (
            <p>
              {result?.value &&
              ["Requires", "Wants", "After", "Before", "RequiredBy", "WantedBy"].every(
                (key) => key in p,
              )
                ? "No relationships reported."
                : "Dependency evidence unavailable."}
            </p>
          )}
        </InspectorDisclosure>
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
              <h3 className="detail-section-heading">Unit files and drop-ins</h3>
              <p className="systemd-evidence-note">
                Files on disk. Loaded properties above may differ when a reload is pending.
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
        {result?.value && (
          <p className="systemd-evidence-note">
            Collected {new Date(result.value.collectedAt).toLocaleTimeString()}
          </p>
        )}
      </div>
      <div className="detail-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={onRefresh}
          aria-label="Refresh unit details"
          disabled={result?.loading}
        >
          <RefreshCw size={14} />
          Refresh
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => onViewLogs({ type: "systemd", id: unitId })}
        >
          <FileClock size={14} />
          View journal
        </button>
        {onOpenPorts && (
          <button type="button" className="secondary-button" onClick={() => onOpenPorts(unitId)}>
            <Network size={14} />
            Ports
          </button>
        )}
        {onOpenBoot && (
          <button type="button" className="secondary-button" onClick={onOpenBoot}>
            <Timer size={14} />
            Boot
          </button>
        )}
      </div>
    </>
  );
}
