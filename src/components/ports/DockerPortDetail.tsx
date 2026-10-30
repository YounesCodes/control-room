import { FileClock, Server } from "lucide-react";
import type { DockerPortLink } from "../../lib/port-inspector";
import type { LogSourceSelection } from "../../types";

export function DockerPortDetail({
  selected,
  onOpenContainer,
  onViewLogs,
}: {
  selected: DockerPortLink;
  onOpenContainer: (containerId: string) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  return (
    <>
      <header>
        <h2>
          {selected.hostPort} → {selected.containerPort}
        </h2>
        <p>{selected.container.name}</p>
      </header>
      <dl className="detail-list">
        <div>
          <dt>Host binding</dt>
          <dd className="technical">
            {selected.hostAddress}:{selected.hostPort}/{selected.protocol}
          </dd>
        </div>
        <div>
          <dt>Container port</dt>
          <dd>
            {selected.containerPort}/{selected.protocol}
          </dd>
        </div>
        <div>
          <dt>Container</dt>
          <dd>{selected.container.name}</dd>
        </div>
        <div>
          <dt>Image</dt>
          <dd className="technical">{selected.container.image}</dd>
        </div>
        {selected.container.composeProject && (
          <div>
            <dt>Compose project</dt>
            <dd>{selected.container.composeProject}</dd>
          </div>
        )}
        {selected.container.composeService && (
          <div>
            <dt>Compose service</dt>
            <dd>{selected.container.composeService}</dd>
          </div>
        )}
      </dl>
      <div className="detail-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={() => onOpenContainer(selected.container.id)}
        >
          <Server size={15} /> Open container
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={() => onViewLogs({ type: "docker", id: selected.container.id })}
        >
          <FileClock size={15} /> View logs
        </button>
      </div>
    </>
  );
}
