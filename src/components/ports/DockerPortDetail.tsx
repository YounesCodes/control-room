import { Container, FileClock } from "lucide-react";
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
      <div
        className="port-inspector-body"
        tabIndex={0}
        role="region"
        aria-label="Docker mapping information"
      >
        <h3 className="detail-section-heading">Binding</h3>
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
        </dl>
        <h3 className="detail-section-heading">Container</h3>
        <dl className="detail-list">
          <div className="inspector-wide-field">
            <dt>Image</dt>
            <dd className="technical">{selected.container.image}</dd>
          </div>
        </dl>
        {(selected.container.composeProject || selected.container.composeService) && (
          <>
            <h3 className="detail-section-heading">Compose</h3>
            <dl className="detail-list">
              {selected.container.composeProject && (
                <div>
                  <dt>Project</dt>
                  <dd>{selected.container.composeProject}</dd>
                </div>
              )}
              {selected.container.composeService && (
                <div>
                  <dt>Service</dt>
                  <dd>{selected.container.composeService}</dd>
                </div>
              )}
            </dl>
          </>
        )}
      </div>
      <div className="detail-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={() => onOpenContainer(selected.container.id)}
        >
          <Container size={15} /> Open container
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
