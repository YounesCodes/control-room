import { useState } from "react";
import { FileClock, Network, RefreshCw, Timer } from "lucide-react";
import { InspectorDisclosure } from "./InspectorDisclosure";
import { SystemdCode } from "./SystemdCode";
import { useSystemdReads } from "../lib/systemd-inspection";
import { systemdValue, systemdStateLabel } from "../lib/systemd-units";
import type { CachedValue, LogSourceSelection, SystemdInspection, SystemdUnit } from "../types";

function Fields({ rows }: { rows: [string, string | undefined][] }) {
  return (
    <dl className="detail-list">
      {rows.map(([label, value]) => {
        const formatted = systemdValue(value);
        const code =
          formatted !== "Unavailable" &&
          ["ExecStart", "Calendar", "Monotonic schedule", "Options"].includes(label);
        const path =
          formatted !== "Unavailable" &&
          ["Unit file", "Source file", "Drop-ins", "Mount point", "Source"].includes(label);
        return (
          <div key={label} className={code ? "inspector-wide-field" : undefined}>
            <dt>{label}</dt>
            <dd>
              {code ? (
                <SystemdCode text={formatted} label={label} command />
              ) : path ? (
                <code className="systemd-inline-code">{formatted}</code>
              ) : (
                formatted
              )}
            </dd>
          </div>
        );
      })}
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
  section: "configuration" | "effectiveConfiguration";
  revision: number;
}) {
  const [retry, setRetry] = useState(0);
  const result = useSystemdReads(connectionId, [unit], revision + retry, section, cacheScope)[unit];
  const content = section === "configuration" ? "unit files" : "effective properties";
  return (
    <>
      {result?.loading && <p role="status">Reading {content}…</p>}
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
      {result?.value &&
        (result.value.text ? (
          <SystemdCode
            text={result.value.text}
            label={section === "configuration" ? "Unit files" : "Effective properties"}
          />
        ) : (
          <p className="systemd-evidence-note">No {content} returned.</p>
        ))}
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
  onViewLogs,
  onOpenPorts,
  onRequestPorts,
  onOpenBoot,
  onRequestBoot,
}: {
  connectionId: string;
  cacheScope?: string;
  unitId: string;
  summary: SystemdUnit | null;
  result?: CachedValue<SystemdInspection>;
  revision: number;
  onRefresh: () => void;
  onViewLogs: (source: LogSourceSelection) => void;
  onOpenPorts?: (unit: string) => void;
  onRequestPorts?: () => void;
  onOpenBoot?: () => void;
  onRequestBoot?: () => void;
}) {
  const [configuration, setConfiguration] = useState(false);
  const [effective, setEffective] = useState(false);
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
      <header className="systemd-unit-reveal">
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
      <div className="port-inspector-body systemd-unit-reveal">
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
        <InspectorDisclosure title="Configuration" open={configuration} onToggle={setConfiguration}>
          {configuration && (
            <>
              <Fields
                rows={[
                  ["Unit file", p.FragmentPath],
                  ["Source file", p.SourcePath],
                  ["Drop-ins", p.DropInPaths === "" ? "None reported" : p.DropInPaths],
                  ["Reload needed", p.NeedDaemonReload],
                ]}
              />
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
        <InspectorDisclosure
          title="Advanced"
          onToggle={(open) => {
            setAdvanced(open);
            if (open && (type === "service" || type === "socket")) onRequestPorts?.();
            if (open) onRequestBoot?.();
            if (!open) {
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
                {onOpenPorts && (type === "service" || type === "socket") && (
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
