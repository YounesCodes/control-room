import { AlertTriangle } from "lucide-react";
import {
  cyclicSystemdUnits,
  relationshipExplanation,
  relationshipLabel,
  relationshipsForRoot,
} from "../../lib/systemd-relationships";
import type {
  SystemdRelationshipEdge,
  SystemdRelationshipNode,
  SystemdRelationships,
} from "../../types";

function RelationshipGroup({
  title,
  root,
  edges,
  nodes,
  cyclic,
  onInspect,
}: {
  title: string;
  root: string;
  edges: SystemdRelationshipEdge[];
  nodes: Map<string, SystemdRelationshipNode>;
  cyclic: Set<string>;
  onInspect: (unit: string) => void;
}) {
  return (
    <section className="relationship-group">
      <h4>{title}</h4>
      {edges.length ? (
        <div className="relationship-list">
          {edges.map((edge) => {
            const relatedId = edge.source === root ? edge.target : edge.source;
            const node = nodes.get(relatedId);
            return (
              <button
                className="relationship-row"
                type="button"
                key={`${edge.source}:${edge.relationship}:${edge.target}`}
                onClick={() => onInspect(relatedId)}
                aria-label={`Inspect ${relatedId}`}
              >
                <span className="relationship-row-heading">
                  <strong>{relatedId}</strong>
                  <span className="relationship-kind">{relationshipLabel(edge.relationship)}</span>
                </span>
                <span className="relationship-state">
                  {node ? `${node.activeState} / ${node.subState}` : "State unavailable"}
                  {cyclic.has(relatedId) ? " · cycle in collected edges" : ""}
                </span>
                <small>{relationshipExplanation(edge.relationship)}</small>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="relationship-empty">None in the collected neighborhood.</p>
      )}
    </section>
  );
}

export function SystemdRelationshipsPanel({
  result,
  onInspect,
}: {
  result: SystemdRelationships;
  onInspect: (unit: string) => void;
}) {
  const groups = relationshipsForRoot(result);
  const nodes = new Map(result.nodes.map((node) => [node.id, node]));
  const cyclic = cyclicSystemdUnits(result);
  const rootInCycle = cyclic.has(result.root);

  return (
    <section className="relationships-panel" aria-label={`Relationships for ${result.root}`}>
      <header>
        <div>
          <h3>Relationships</h3>
          <p>
            One-hop systemd neighborhood · {result.nodes.length} unit
            {result.nodes.length === 1 ? "" : "s"}
          </p>
        </div>
      </header>
      {result.truncated && (
        <p className="inline-warning">
          Some relationships fall beyond this one-hop neighborhood or its {result.nodeLimit}-unit
          and {result.edgeLimit}-edge limits.
        </p>
      )}
      {rootInCycle && (
        <p className="relationship-cycle-note">
          <AlertTriangle size={14} /> A cycle is present in the collected edges. This does not show
          that the cycle caused a failure.
        </p>
      )}
      <RelationshipGroup
        title="Outgoing from this unit"
        root={result.root}
        edges={groups.outgoing}
        nodes={nodes}
        cyclic={cyclic}
        onInspect={onInspect}
      />
      <RelationshipGroup
        title="Incoming to this unit"
        root={result.root}
        edges={groups.incoming}
        nodes={nodes}
        cyclic={cyclic}
        onInspect={onInspect}
      />
    </section>
  );
}
