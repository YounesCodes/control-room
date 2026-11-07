import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { layoutSystemdGraph } from "../lib/systemd-graph-layout";
import { systemdStateLabel } from "../lib/systemd-units";
import type { SystemdUnit } from "../types";

type Layout = ReturnType<typeof layoutSystemdGraph>;
type Scene = { layout: Layout; root: string; scope: string; units: SystemdUnit[] };
type Exit = { key: number; scene: Scene; ids: string[]; connections: Layout["connections"] };

/** Visual-only snapshots let removed nodes and their connectors finish one short fade. */
export function SystemdGraphExits({ layout, root, scope, units }: Scene) {
  const previous = useRef<Scene | null>(null);
  const serial = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const [exits, setExits] = useState<Exit[]>([]);
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    [],
  );
  useLayoutEffect(() => {
    const old = previous.current;
    previous.current = { layout, root, scope, units };
    if (!old || old.root !== root || old.scope !== scope) {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      setExits([]);
      return;
    }
    const ids = [...old.layout.positions.keys()].filter((id) => !layout.positions.has(id));
    const activeEdges = new Set(layout.connections.map((edge) => edge.id));
    const connections = old.layout.connections.filter((edge) => !activeEdges.has(edge.id));
    if (!ids.length && !connections.length) return;
    const key = ++serial.current;
    const removedIds = new Set(ids);
    const removedEdges = new Set(connections.map((edge) => edge.id));
    setExits((current) =>
      [
        ...current.map((exit) => ({
          ...exit,
          ids: exit.ids.filter((id) => !removedIds.has(id)),
          connections: exit.connections.filter((edge) => !removedEdges.has(edge.id)),
        })),
        { key, scene: old, ids, connections },
      ]
        .filter((exit) => exit.ids.length || exit.connections.length)
        .slice(-8),
    );
    timers.current.set(
      key,
      setTimeout(() => {
        setExits((current) => current.filter((exit) => exit.key !== key));
        timers.current.delete(key);
      }, 240),
    );
  }, [layout, root, scope, units]);
  const activeEdges = new Set(layout.connections.map((edge) => edge.id));
  const center = layout.positions.get(root)!;
  return (
    <div className="systemd-graph-exits" aria-hidden="true" inert>
      {exits.map((exit) => {
        if (exit.scene.root !== root || exit.scene.scope !== scope) return null;
        const oldCenter = exit.scene.layout.positions.get(root)!;
        return (
          <div
            key={exit.key}
            className="systemd-graph-exit-scene"
            style={{
              transform: `translate(${center.x - oldCenter.x}px, ${center.y - oldCenter.y}px)`,
            }}
          >
            <svg
              className="systemd-edges"
              width={exit.scene.layout.width}
              height={exit.scene.layout.height}
            >
              {exit.connections
                .filter((edge) => !activeEdges.has(edge.id))
                .map((edge) => (
                  <g key={edge.id} className={"relationship-" + edge.kind}>
                    <path className="systemd-edge-path" d={edge.path} />
                    <path className="systemd-arrowhead" d={edge.arrowhead} />
                  </g>
                ))}
            </svg>
            {exit.ids
              .filter((id) => !layout.positions.has(id))
              .map((id) => {
                const node = exit.scene.layout.positions.get(id)!;
                const unit = exit.scene.units.find((item) => item.id === id);
                return (
                  <div
                    key={id}
                    className="systemd-graph-ghost"
                    data-unit={id}
                    style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
                  >
                    <div className="arch-chip">
                      <span className="arch-chip-title">
                        <strong>{id}</strong>
                      </span>
                      <span className="arch-chip-kind">
                        {systemdStateLabel(unit?.activeState, unit?.subState)}
                      </span>
                    </div>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
