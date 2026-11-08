import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileClock, Network, RefreshCw } from "lucide-react";
import { InspectorDisclosure } from "./InspectorDisclosure";
import { SystemdCode } from "./SystemdCode";
import { AnimatedNumber } from "./AnimatedNumber";
import { useSystemdReads } from "../lib/systemd-inspection";
import { systemdValue, systemdStateLabel } from "../lib/systemd-units";
import type { CachedValue, LogSourceSelection, SystemdInspection, SystemdUnit } from "../types";

export interface SystemdInspectorViewState {
  configuration: boolean;
  advanced: boolean;
  effective: boolean;
  scroll: Record<string, { top: number; left: number }>;
}

function formatMemory(bytes: number) {
  return resource(String(bytes), 1048576, " MiB");
}

const runtimeFormats: Record<string, (value: number) => string> = {
  Memory: formatMemory,
  "CPU time": (value) => resource(String(value), 1e9, " s"),
  Tasks: (value) => Math.round(value).toLocaleString(),
  Restarts: (value) => Math.round(value).toLocaleString(),
  Uptime: duration,
};

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
              {runtimeFormats[label] ? (
                <AnimatedNumber
                  value={formatted === "Unavailable" ? null : Number(formatted)}
                  format={runtimeFormats[label]}
                  className={label === "Memory" ? "systemd-memory-value" : undefined}
                />
              ) : code ? (
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
  initialViewState,
  onViewStateChange,
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
  initialViewState?: SystemdInspectorViewState;
  onViewStateChange?: (state: SystemdInspectorViewState) => void;
}) {
  const [configuration, setConfiguration] = useState(initialViewState?.configuration ?? false);
  const [effective, setEffective] = useState(initialViewState?.effective ?? false);
  const [advanced, setAdvanced] = useState(initialViewState?.advanced ?? false);
  useEffect(() => {
    if (!initialViewState?.advanced) return;
    // Restoring an open disclosure must recheck evidence freshness too.
    // The parent loaders reuse fresh caches and deduplicate pending requests.
    if (/\.(service|socket)$/.test(unitId)) onRequestPorts?.();
  }, []);
  const bodyRef = useRef<HTMLDivElement>(null);
  const latestView = useRef({ configuration, effective, advanced, onViewStateChange });
  latestView.current = { configuration, effective, advanced, onViewStateChange };
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const elements = () =>
      new Map<string, HTMLElement>([
        ...[...body.querySelectorAll<HTMLElement>(".systemd-code")].map(
          (element): [string, HTMLElement] => [
            element.getAttribute("aria-label") ?? "code",
            element,
          ],
        ),
        ["body", body],
      ]);
    const pending = new Map(Object.entries(initialViewState?.scroll ?? {}));
    const restore = () => {
      for (const [key, element] of elements()) {
        const position = pending.get(key);
        if (!position) continue;
        element.scrollTop = position.top;
        element.scrollLeft = position.left;
        if (
          Math.abs(element.scrollTop - position.top) < 1 &&
          Math.abs(element.scrollLeft - position.left) < 1 &&
          (key !== "body" || pending.size === 1)
        )
          pending.delete(key);
      }
      if (!pending.size) observer.disconnect();
    };
    // Evidence can arrive after mount; restore again once its scroll range exists.
    const observer = new MutationObserver(restore);
    if (pending.size) observer.observe(body, { childList: true, subtree: true });
    restore();
    const cancel = () => {
      pending.clear();
      observer.disconnect();
    };
    for (const event of ["wheel", "pointerdown", "keydown"])
      body.addEventListener(event, cancel, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      for (const event of ["wheel", "pointerdown", "keydown"])
        body.removeEventListener(event, cancel, true);
      const { onViewStateChange: save, ...sections } = latestView.current;
      const scroll = Object.fromEntries(pending);
      for (const [key, element] of elements()) {
        if (!pending.has(key)) scroll[key] = { top: element.scrollTop, left: element.scrollLeft };
      }
      save?.({
        ...sections,
        scroll,
      });
    };
  }, []);
  const p = result?.value?.properties ?? {};
  const type = unitId.split(".").at(-1);
  const active = p.ActiveState ?? summary?.activeState;
  const sub = p.SubState ?? summary?.subState;
  const failed = active === "failed";
  const uptime =
    active === "active" && p.ActiveEnterTimestamp && p.ControlRoomRealtimeSeconds
      ? String(Number(p.ControlRoomRealtimeSeconds) - Date.parse(p.ActiveEnterTimestamp) / 1000)
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
            ? [["Memory", p.MemoryCurrent] as [string, string]]
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
          ["CPU time", p.CPUUsageNSec],
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
      <div ref={bodyRef} className="port-inspector-body systemd-unit-reveal">
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
          open={advanced}
          onToggle={(open) => {
            if (open === advanced) return;
            setAdvanced(open);
            if (open && (type === "service" || type === "socket")) onRequestPorts?.();
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
              <InspectorDisclosure
                title="Effective properties"
                open={effective}
                onToggle={setEffective}
              >
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
