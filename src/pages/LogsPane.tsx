import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Eraser, Pause, Play, Search, Square } from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import type {
  AppSettings,
  DockerContainer,
  SavedConnection,
  StreamStateEvent,
  SystemdService,
} from "../types";

type SourceType = "systemd" | "docker";

export function LogsPane({
  connection,
  settings,
}: {
  connection: SavedConnection;
  settings: AppSettings;
}) {
  const [sourceType, setSourceType] = useState<SourceType>("systemd");
  const [services, setServices] = useState<SystemdService[]>([]);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [tail, setTail] = useState(settings.defaultLogTail);
  const [follow, setFollow] = useState(true);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [paused, setPaused] = useState(false);
  const [logs, setLogs] = useState("");
  const [search, setSearch] = useState("");
  const [loadingSources, setLoadingSources] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestSudo, setRequestSudo] = useState(false);
  const pausedRef = useRef(false);
  const pendingRef = useRef("");
  const decoderRef = useRef(new TextDecoder());
  const streamIdRef = useRef<string | null>(null);

  useEffect(() => {
    streamIdRef.current = streamId;
  }, [streamId]);

  useEffect(() => {
    let current = true;
    setLoadingSources(true);
    void Promise.allSettled([api.listServices(connection.id), api.listContainers(connection.id)])
      .then((results) => {
        if (!current) return;
        const serviceResult = results[0];
        const containerResult = results[1];
        const nextServices = serviceResult.status === "fulfilled" ? serviceResult.value : [];
        const nextContainers = containerResult.status === "fulfilled" ? containerResult.value : [];
        setServices(nextServices);
        setContainers(nextContainers);
        setSourceType(nextServices.length ? "systemd" : "docker");
        setSourceId(nextServices[0]?.id ?? nextContainers[0]?.id ?? "");
      })
      .finally(() => current && setLoadingSources(false));
    return () => {
      current = false;
      if (streamIdRef.current) void api.stopLogStream(streamIdRef.current).catch(() => undefined);
    };
  }, [connection.id]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<StreamStateEvent>("stream-state-changed", ({ payload }) => {
      if (payload.streamId !== streamIdRef.current) return;
      if (payload.state === "error") setError(payload.reason ?? "Log stream failed");
      if (payload.state !== "running") {
        setStreaming(false);
        setStreamId(null);
      }
    }).then((listener) => {
      unlisten = listener;
    });
    return () => unlisten?.();
  }, []);

  async function stop() {
    if (!streamIdRef.current) return;
    await api.stopLogStream(streamIdRef.current).catch(() => undefined);
    setStreaming(false);
    setStreamId(null);
  }

  async function start(sudoPassword: string | null = null) {
    if (!sourceId) return;
    await stop();
    setError(null);
    setRequestSudo(false);
    setStreaming(true);
    decoderRef.current = new TextDecoder();
    const output = new Channel<ArrayBuffer>();
    output.onmessage = (message) => {
      const chunk = decoderRef.current.decode(new Uint8Array(message), { stream: true });
      if (pausedRef.current) {
        pendingRef.current += chunk;
        return;
      }
      setLogs((current) => trimLogBuffer(current + chunk));
    };
    try {
      const started =
        sourceType === "systemd"
          ? await api.startJournalStream(
              connection.id,
              sourceId,
              tail,
              follow,
              sudoPassword,
              output,
            )
          : await api.startDockerLogStream(
              connection.id,
              sourceId,
              tail,
              follow,
              sudoPassword,
              output,
            );
      setStreamId(started.streamId);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStreaming(false);
      if (message.toLowerCase().includes("permission denied")) setRequestSudo(true);
    }
  }

  function togglePause() {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (!next && pendingRef.current) {
      const pending = pendingRef.current;
      pendingRef.current = "";
      setLogs((current) => trimLogBuffer(current + pending));
    }
  }

  function changeType(next: SourceType) {
    void stop();
    setSourceType(next);
    setSourceId(next === "systemd" ? (services[0]?.id ?? "") : (containers[0]?.id ?? ""));
    setLogs("");
  }

  const displayedLogs = useMemo(() => {
    if (!search.trim()) return logs;
    const query = search.toLowerCase();
    return logs
      .split("\n")
      .filter((line) => line.toLowerCase().includes(query))
      .join("\n");
  }, [logs, search]);

  if (loadingSources) return <LoadingState label="Finding available log sources…" />;
  const sourceOptions = sourceType === "systemd" ? services : containers;

  return (
    <section className="feature-page logs-page">
      <header className="page-heading compact-heading">
        <div>
          <p className="eyebrow">Live output</p>
          <h2>Logs</h2>
          <p>{streaming ? (paused ? "Rendering paused" : "Stream active") : "Stream stopped"}</p>
        </div>
        <div className="toolbar-actions">
          <button
            className="toolbar-button"
            type="button"
            onClick={() => start()}
            disabled={!sourceId || streaming}
          >
            <Play size={14} /> Start
          </button>
          <button
            className="toolbar-button"
            type="button"
            onClick={togglePause}
            disabled={!streaming}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? "Resume" : "Pause"}
          </button>
          <button className="toolbar-button" type="button" onClick={stop} disabled={!streaming}>
            <Square size={13} /> Stop
          </button>
          <button className="toolbar-button" type="button" onClick={() => setLogs("")}>
            <Eraser size={14} /> Clear view
          </button>
        </div>
      </header>
      <div className="log-controls">
        <label>
          <span>Source</span>
          <select
            value={sourceType}
            onChange={(event) => changeType(event.target.value as SourceType)}
          >
            <option value="systemd">systemd</option>
            <option value="docker">Docker</option>
          </select>
        </label>
        <label className="source-select">
          <span>{sourceType === "systemd" ? "Service" : "Container"}</span>
          <select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
            {sourceOptions.map((source) => (
              <option value={source.id} key={source.id}>
                {"name" in source ? source.name : source.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Lines</span>
          <select value={tail} onChange={(event) => setTail(Number(event.target.value))}>
            {[50, 100, 200, 500, 1000].map((count) => (
              <option key={count}>{count}</option>
            ))}
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
          />{" "}
          Follow
        </label>
        <label className="search-field log-search">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search loaded lines"
          />
        </label>
      </div>
      {error && (
        <ErrorState
          message={error}
          action={
            error.toLowerCase().includes("permission denied") ? (
              <button onClick={() => setRequestSudo(true)}>Retry with sudo</button>
            ) : undefined
          }
        />
      )}
      {!error && (
        <pre className="log-output" aria-live="polite">
          {displayedLogs || "Choose a source and start the stream."}
        </pre>
      )}
      {requestSudo && (
        <CredentialDialog
          connectionLabel={connection.displayName}
          onClose={() => setRequestSudo(false)}
          onSubmit={(password) => start(password)}
        />
      )}
    </section>
  );
}

function trimLogBuffer(value: string): string {
  const lines = value.split("\n");
  return lines.length > 10_000 ? lines.slice(-10_000).join("\n") : value;
}
