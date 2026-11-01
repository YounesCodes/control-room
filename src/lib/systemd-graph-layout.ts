import type { SystemdEdge } from "./systemd-units";

export const SYSTEMD_NODE_WIDTH = 216;
export const SYSTEMD_NODE_HEIGHT = 64;
const COLUMN_STEP = 360;
const ROW_STEP = 88;
const PADDING = 24;

export interface GraphPoint {
  x: number;
  y: number;
}
export interface SystemdGraphPlacement {
  column: number;
  row: number;
}
export interface SystemdGraphNode extends GraphPoint {
  width: number;
  height: number;
}
export interface SystemdConnection {
  id: string;
  source: string;
  target: string;
  edges: SystemdEdge[];
  kind: "requires" | "wants" | "ordering" | "activation";
  path: string;
  label: string;
  labelPoint: GraphPoint;
}

function roundedPath(points: GraphPoint[]) {
  let path = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1],
      corner = points[i],
      next = points[i + 1];
    const incoming = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outgoing = Math.hypot(next.x - corner.x, next.y - corner.y);
    if (!incoming || !outgoing) continue;
    const radius = Math.min(8, incoming / 2, outgoing / 2);
    path += ` L${corner.x + ((previous.x - corner.x) * radius) / incoming},${corner.y + ((previous.y - corner.y) * radius) / incoming} Q${corner.x},${corner.y} ${corner.x + ((next.x - corner.x) * radius) / outgoing},${corner.y + ((next.y - corner.y) * radius) / outgoing}`;
  }
  const last = points.at(-1)!;
  return path + ` L${last.x},${last.y}`;
}

/** Ordering is drawn from the earlier unit to the later unit. Before and its
 * inverse After are the same constraint; keep both original evidence records. */
export function layoutSystemdGraph(
  ids: string[],
  edges: SystemdEdge[],
  root: string,
  previous = new Map<string, SystemdGraphPlacement>(),
) {
  const visible = new Set(ids);
  const grouped = new Map<string, SystemdConnection>();
  for (const edge of edges) {
    if (!visible.has(edge.source) || !visible.has(edge.target) || edge.source === edge.target)
      continue;
    const source = edge.relationship === "After" ? edge.target : edge.source;
    const target = edge.relationship === "After" ? edge.source : edge.target;
    const ordering = edge.relationship === "After" || edge.relationship === "Before";
    const id = JSON.stringify([source, target, ordering ? "ordering" : "dependency"]);
    let connection = grouped.get(id);
    if (!connection) {
      connection = {
        id,
        source,
        target,
        edges: [],
        kind: ordering
          ? "ordering"
          : edge.relationship === "Triggers"
            ? "activation"
            : edge.relationship === "Requires"
              ? "requires"
              : "wants",
        path: "",
        label: "",
        labelPoint: { x: 0, y: 0 },
      };
      grouped.set(id, connection);
    }
    connection.edges.push(edge);
    if (edge.relationship === "Requires") connection.kind = "requires";
  }
  const connections = [...grouped.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const adjacent = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const edge of connections) {
    adjacent.get(edge.source)!.add(edge.target);
    adjacent.get(edge.target)!.add(edge.source);
  }
  const placements = new Map<string, SystemdGraphPlacement>([[root, { column: 0, row: 0 }]]);
  const occupied = new Map<number, Set<number>>([[0, new Set([0])]]);
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i];
    const neighbors = [...(adjacent.get(parent) ?? [])].sort(
      (a, b) => Number(previous.has(b)) - Number(previous.has(a)) || (a < b ? -1 : a > b ? 1 : 0),
    );
    for (const id of neighbors) {
      if (placements.has(id)) continue;
      const direction =
        parent === root
          ? connections.some((edge) => edge.source === root && edge.target === id)
            ? 1
            : -1
          : Math.sign(placements.get(parent)!.column);
      const old = previous.get(id);
      let column =
        old && Math.sign(old.column) === direction
          ? old.column
          : placements.get(parent)!.column + direction;
      while (
        [...(adjacent.get(id) ?? [])].some(
          (neighbor) => placements.get(neighbor)?.column === column,
        )
      )
        column += direction;
      const rows = occupied.get(column) ?? new Set<number>();
      let row = old?.column === column ? old.row : 0;
      for (let slot = 0; rows.has(row); slot++)
        row = slot % 2 === 0 ? -(slot / 2 + 1) : (slot + 1) / 2;
      rows.add(row);
      occupied.set(column, rows);
      placements.set(id, { column, row });
      queue.push(id);
    }
  }
  for (const id of ids)
    if (!placements.has(id)) {
      const column = 1,
        rows = occupied.get(column) ?? new Set<number>();
      let row = 0;
      while (rows.has(row)) row++;
      rows.add(row);
      occupied.set(column, rows);
      placements.set(id, { column, row });
    }
  const minX = Math.min(...[...placements.values()].map((point) => point.column * COLUMN_STEP));
  const minY = Math.min(...[...placements.values()].map((point) => point.row * ROW_STEP));
  const long = connections.filter(
    (edge) =>
      Math.abs(placements.get(edge.source)!.column - placements.get(edge.target)!.column) > 1,
  );
  const top = long.length * 12;
  const positions = new Map<string, SystemdGraphNode>(
    ids.map((id) => {
      const point = placements.get(id)!;
      return [
        id,
        {
          x: PADDING + point.column * COLUMN_STEP - minX,
          y: PADDING + top + point.row * ROW_STEP - minY,
          width: SYSTEMD_NODE_WIDTH,
          height: SYSTEMD_NODE_HEIGHT,
        },
      ];
    }),
  );
  function port(id: string, connection: SystemdConnection, side: number) {
    const node = positions.get(id)!;
    const onSide = connections
      .filter((edge) => edge.source === id || edge.target === id)
      .filter((edge) => {
        const other = positions.get(edge.source === id ? edge.target : edge.source)!;
        return Math.sign(other.x - node.x) === side;
      })
      .sort((a, b) => {
        const otherA = positions.get(a.source === id ? a.target : a.source)!;
        const otherB = positions.get(b.source === id ? b.target : b.source)!;
        return otherA.y - otherB.y || (a.id < b.id ? -1 : 1);
      });
    return {
      x: side > 0 ? node.x + node.width + 4 : node.x - 4,
      y:
        node.y + 10 + ((node.height - 20) * (onSide.indexOf(connection) + 1)) / (onSide.length + 1),
    };
  }
  for (const connection of connections) {
    const source = positions.get(connection.source)!,
      target = positions.get(connection.target)!;
    const direction = Math.sign(target.x - source.x);
    const start = port(connection.source, connection, direction),
      end = port(connection.target, connection, -direction);
    const middle = (start.x + end.x) / 2;
    const track = long.indexOf(connection);
    connection.path =
      track < 0
        ? `M${start.x},${start.y} C${middle},${start.y} ${middle},${end.y} ${end.x},${end.y}`
        : roundedPath([
            start,
            { x: start.x + direction * 12, y: start.y },
            { x: start.x + direction * 12, y: 12 + track * 12 },
            { x: end.x - direction * 12, y: 12 + track * 12 },
            { x: end.x - direction * 12, y: end.y },
            end,
          ]);
    connection.label =
      connection.kind === "ordering"
        ? "Before"
        : [...new Set(connection.edges.map((edge) => edge.relationship))].join(" · ");
    const farTarget =
      Math.abs(placements.get(connection.target)!.column) >=
      Math.abs(placements.get(connection.source)!.column);
    connection.labelPoint = {
      x: farTarget ? end.x - direction * 66 : start.x + direction * 66,
      y: (farTarget ? end.y : start.y) - 7,
    };
  }
  return {
    positions,
    placements,
    connections,
    width: Math.max(...[...positions.values()].map((node) => node.x + node.width)) + PADDING,
    height: Math.max(...[...positions.values()].map((node) => node.y + node.height)) + PADDING,
  };
}
