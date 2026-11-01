import type { SystemdEdge } from "./systemd-units";

export const SYSTEMD_NODE_WIDTH = 236;
export const SYSTEMD_NODE_HEIGHT = 78;
const GAP = 248;
const PADDING = 24;
const BADGE_WIDTH = 144;
const ROW_HEIGHT = 26;

export interface GraphPoint {
  x: number;
  y: number;
}
export interface SystemdGraphNode extends GraphPoint {
  width: number;
  height: number;
}
export interface SystemdConnection {
  id: string;
  left: string;
  right: string;
  edges: SystemdEdge[];
  badge: GraphPoint & { width: number; height: number };
  paths: [string, string];
  arrowLeft: boolean;
  arrowRight: boolean;
}

/** Round a gutter route without cutting across the cards at its endpoints. */
function roundedPath(points: GraphPoint[]) {
  let path = `M${points[0].x},${points[0].y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const before = points[index - 1];
    const corner = points[index];
    const after = points[index + 1];
    const incoming = Math.hypot(corner.x - before.x, corner.y - before.y);
    const outgoing = Math.hypot(after.x - corner.x, after.y - corner.y);
    if (!incoming || !outgoing) continue;
    const radius = Math.min(8, incoming / 2, outgoing / 2);
    const start = {
      x: corner.x + ((before.x - corner.x) * radius) / incoming,
      y: corner.y + ((before.y - corner.y) * radius) / incoming,
    };
    const end = {
      x: corner.x + ((after.x - corner.x) * radius) / outgoing,
      y: corner.y + ((after.y - corner.y) * radius) / outgoing,
    };
    path += ` L${start.x},${start.y} Q${corner.x},${corner.y} ${end.x},${end.y}`;
  }
  const end = points.at(-1)!;
  return path + ` L${end.x},${end.y}`;
}

function curve(start: GraphPoint, end: GraphPoint) {
  const middle = (start.x + end.x) / 2;
  return `M${start.x},${start.y} C${middle},${start.y} ${middle},${end.y} ${end.x},${end.y}`;
}

/** Labels own real layout space. Parallel relationships share a connector,
 * while each reported relationship keeps its own label and direction. */
export function layoutSystemdGraph(ids: string[], edges: SystemdEdge[], root: string) {
  const visible = new Set(ids);
  const evidence = edges.filter(
    (edge) => visible.has(edge.source) && visible.has(edge.target) && edge.source !== edge.target,
  );
  const neighbors = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const edge of evidence) {
    neighbors.get(edge.source)!.add(edge.target);
    neighbors.get(edge.target)!.add(edge.source);
  }
  const depths = new Map([[root, 0]]);
  const order = [root];
  for (let index = 0; index < order.length; index++)
    for (const neighbor of neighbors.get(order[index]) ?? []) {
      if (depths.has(neighbor)) continue;
      depths.set(neighbor, (depths.get(order[index]) ?? 0) + 1);
      order.push(neighbor);
    }
  for (const id of ids)
    if (!depths.has(id)) {
      depths.set(id, 1);
      order.push(id);
    }

  // Adjacent units never occupy the same column, including cycle members.
  // This lets every connector stay in gutters rather than crossing cards.
  const columns = new Map<string, number>();
  const columnSizes = new Map<number, number>();
  for (const id of order) {
    let column = depths.get(id) ?? 1;
    while (
      (columnSizes.get(column) ?? 0) >= 8 ||
      [...(neighbors.get(id) ?? [])].some((neighbor) => columns.get(neighbor) === column)
    )
      column++;
    columns.set(id, column);
    columnSizes.set(column, (columnSizes.get(column) ?? 0) + 1);
  }
  const columnNumbers = [...new Set(columns.values())].sort((a, b) => a - b);
  const compactColumns = new Map(columnNumbers.map((column, index) => [column, index]));
  for (const [id, column] of columns) columns.set(id, compactColumns.get(column)!);

  const pairs = new Map<string, SystemdConnection>();
  for (const edge of evidence) {
    const left = columns.get(edge.source)! < columns.get(edge.target)! ? edge.source : edge.target;
    const right = left === edge.source ? edge.target : edge.source;
    const id = JSON.stringify([left, right]);
    let connection = pairs.get(id);
    if (!connection) {
      connection = {
        id,
        left,
        right,
        edges: [],
        badge: { x: 0, y: 0, width: BADGE_WIDTH, height: 0 },
        paths: ["", ""],
        arrowLeft: false,
        arrowRight: false,
      };
      pairs.set(id, connection);
    }
    connection.edges.push(edge);
    connection.arrowLeft ||= edge.target === left;
    connection.arrowRight ||= edge.target === right;
  }
  const connections = [...pairs.values()];
  const incoming = new Map(
    ids.map((id) => [id, connections.filter((connection) => connection.right === id)]),
  );
  const incident = new Map(
    ids.map((id) => [
      id,
      connections.filter((connection) => connection.left === id || connection.right === id),
    ]),
  );
  const longConnections = connections.filter(
    (connection) => columns.get(connection.right)! - columns.get(connection.left)! > 1,
  );
  const top = PADDING + longConnections.length * 12;
  const nodeHeights = new Map(
    ids.map((id) => [id, Math.max(SYSTEMD_NODE_HEIGHT, (incident.get(id)?.length ?? 0) * 8 + 24)]),
  );
  const blocks = new Map(
    ids.map((id) => [
      id,
      Math.max(
        nodeHeights.get(id)! + 32,
        (incoming.get(id) ?? []).reduce(
          (height, connection) => height + connection.edges.length * ROW_HEIGHT + 24,
          0,
        ),
      ),
    ]),
  );
  const heights = columnNumbers.map((_, column) =>
    ids
      .filter((id) => columns.get(id) === column)
      .reduce((height, id) => height + blocks.get(id)!, 0),
  );
  const bodyHeight = Math.max(SYSTEMD_NODE_HEIGHT + 32, ...heights);
  const positions = new Map<string, SystemdGraphNode>();
  for (let column = 0; column < columnNumbers.length; column++) {
    let y = top + PADDING + (bodyHeight - heights[column]) / 2;
    for (const id of ids.filter((id) => columns.get(id) === column)) {
      const x = PADDING + column * (SYSTEMD_NODE_WIDTH + GAP);
      positions.set(id, {
        x,
        y: y + (blocks.get(id)! - nodeHeights.get(id)!) / 2,
        width: SYSTEMD_NODE_WIDTH,
        height: nodeHeights.get(id)!,
      });
      const badges = incoming.get(id) ?? [];
      const total = badges.reduce(
        (height, connection) => height + connection.edges.length * ROW_HEIGHT + 24,
        0,
      );
      let badgeY = y + (blocks.get(id)! - total) / 2 + 6;
      for (const connection of badges) {
        connection.badge = {
          x: x - GAP / 2 - BADGE_WIDTH / 2,
          y: badgeY,
          width: BADGE_WIDTH,
          height: connection.edges.length * ROW_HEIGHT + 12,
        };
        badgeY += connection.badge.height + 12;
      }
      y += blocks.get(id)!;
    }
  }

  function port(id: string, connection: SystemdConnection, side: "left" | "right") {
    const node = positions.get(id)!;
    const onSide = (incident.get(id) ?? [])
      .filter((candidate) => (side === "right" ? candidate.left === id : candidate.right === id))
      .sort((a, b) => a.badge.y - b.badge.y);
    const index = onSide.indexOf(connection);
    return {
      x: side === "right" ? node.x + node.width + 5 : node.x - 5,
      y: node.y + 12 + ((node.height - 24) * (index + 1)) / (onSide.length + 1),
    };
  }

  for (const connection of connections) {
    const left = port(connection.left, connection, "right");
    const right = port(connection.right, connection, "left");
    const badge = connection.badge;
    const entrance = { x: badge.x - 4, y: badge.y + badge.height / 2 };
    const exit = { x: badge.x + badge.width + 4, y: entrance.y };
    const track = longConnections.indexOf(connection);
    const laneX = left.x + 12;
    const lastLaneX = positions.get(connection.right)!.x - GAP + 20;
    connection.paths = [
      track < 0
        ? curve(left, entrance)
        : roundedPath([
            left,
            { x: laneX, y: left.y },
            { x: laneX, y: PADDING + track * 12 },
            { x: lastLaneX, y: PADDING + track * 12 },
            { x: lastLaneX, y: entrance.y },
            entrance,
          ]),
      curve(exit, right),
    ];
  }
  return {
    positions,
    connections,
    width:
      PADDING * 2 +
      Math.max(0, columnNumbers.length - 1) * (SYSTEMD_NODE_WIDTH + GAP) +
      SYSTEMD_NODE_WIDTH,
    height: top + bodyHeight + PADDING * 2,
  };
}
