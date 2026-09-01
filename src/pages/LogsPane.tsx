import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Eraser, FileClock, Pause, Play, Search, Square } from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import { BoundedLogBuffer, logRenderDelay } from "../lib/log-buffer";
import { isCacheFresh, reconcileSelection } from "../lib/workspace-cache";
import type {
  AppSettings,
  CachedList,
  DockerContainer,
  LogSourceSelection,
  LogSourceType,
  SavedConnection,
  StreamStateEvent,
  SystemdUnit,
} from "../types";

type StreamStatus = "stopped" | "starting" | "running" | "stopping";
type SudoPurpose = "sources" | "stream";
const MAX_EARLY_STREAM_EVENTS = 16;

export function LogsPane({
  connection,
  settings,
  logTailOptions,
  servicesCache,
  containersCache,
  selectedSource,
  onServicesCacheChange,
  onContainersCacheChange,
  onSourceChange,
  onStreamLifecycle,
}: {
  connection: SavedConnection;
  settings: AppSettings;
  logTailOptions: number[];
  servicesCache: CachedList<SystemdUnit>;
  containersCache: CachedList<DockerContainer>;
  selectedSource: LogSourceSelection | null;
  onServicesCacheChange: (cache: CachedList<SystemdUnit>) => void;
  onContainersCacheChange: (cache: CachedList<DockerContainer>) => void;
  onSourceChange: (source: LogSourceSelection | null) => void;
  onStreamLifecycle: (source: LogSourceSelection, started: boolean) => void;
}) {
  const [sourceType, setSourceType] = useState<LogSourceType>(selectedSource?.type ?? "systemd");
  const [sourceId, setSourceId] = useState(selectedSource?.id ?? "");
  const [tail, setTail] = useState(settings.defaultLogTail);
  const [follow, setFollow] = useState(true);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("stopped");
  const [paused, setPaused] = useState(false);
  const [logs, setLogs] = useState("");
  const [search, setSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sudoPurpose, setSudoPurpose] = useState<SudoPurpose | null>(null);

  const activeBufferRef = useRef(new BoundedLogBuffer());
  const pausedBufferRef = useRef(new BoundedLogBuffer());
  const decoderRef = useRef(new TextDecoder());
  const pausedRef = useRef(false);
  const streamIdRef = useRef<string | null>(null);
  const streamGenerationRef = useRef(0);
  const sourceRequestRef = useRef(0);
  const flushTimerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const startingRef = useRef(false);
  const earlyStateRef = useRef(new Map<string, StreamStateEvent>());
  const servicesCacheRef = useRef(servicesCache);
  const containersCacheRef = useRef(containersCache);
  servicesCacheRef.current = servicesCache;
  containersCacheRef.current = containersCache;

  function flushNow() {
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
    setLogs(activeBufferRef.current.snapshot());
  }

  function scheduleFlush() {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(
      flushNow,
      logRenderDelay(activeBufferRef.current.byteCount),
    );
  }

  function appendChunk(chunk: string) {
    if (!chunk) return;
    if (pausedRef.current) {
      pausedBufferRef.current.append(chunk);
    } else {
      activeBufferRef.current.append(chunk);
      scheduleFlush();
    }
  }

  function finishDecoder() {
    appendChunk(decoderRef.current.decode());
    flushNow();
  }

  function drainPausedBuffer() {
    if (pausedBufferRef.current.byteCount) {
      activeBufferRef.current.append(pausedBufferRef.current.snapshot());
      pausedBufferRef.current.clear();
    }
    pausedRef.current = false;
    setPaused(false);
    flushNow();
  }

  function applyStreamState(payload: StreamStateEvent) {
    if (payload.streamId !== streamIdRef.current) {
      if (startingRef.current) {
        const events = earlyStateRef.current;
        events.set(payload.streamId, payload);
        while (events.size > MAX_EARLY_STREAM_EVENTS) {
          const oldest = events.keys().next().value;
          if (oldest === undefined) break;
          events.delete(oldest);
        }
      }
      return;
    }
    if (payload.state === "error") setError(payload.reason ?? "Log stream failed");
    if (payload.state !== "running") {
      finishDecoder();
      drainPausedBuffer();
      streamIdRef.current = null;
      startingRef.current = false;
      setStreamStatus("stopped");
    }
  }

  async function loadSources(
    type: LogSourceType,
    force = false,
    sudoPassword: string | null = null,
  ) {
    const cache = type === "systemd" ? servicesCacheRef.current : containersCacheRef.current;
    if (!force && isCacheFresh(cache)) return;
    const request = ++sourceRequestRef.current;
    if (type === "systemd") {
      onServicesCacheChange({ ...servicesCacheRef.current, loading: true, error: null });
    } else {
      onContainersCacheChange({ ...containersCacheRef.current, loading: true, error: null });
    }
    try {
      if (type === "systemd") {
        const items = await api.listServices(connection.id);
        if (request !== sourceRequestRef.current) return;
        onServicesCacheChange({ items, fetchedAt: Date.now(), loading: false, error: null });
      } else {
        const items = await api.listContainers(connection.id, sudoPassword);
        if (request !== sourceRequestRef.current) return;
        onContainersCacheChange({ items, fetchedAt: Date.now(), loading: false, error: null });
        setSudoPurpose(null);
      }
    } catch (caught) {
      if (request !== sourceRequestRef.current) return;
      const message = errorMessage(caught);
      if (type === "systemd") {
        onServicesCacheChange({ ...servicesCacheRef.current, loading: false, error: message });
      } else {
        onContainersCacheChange({ ...containersCacheRef.current, loading: false, error: message });
      }
    }
  }

  useEffect(() => {
    void loadSources(sourceType);
    return () => {
      sourceRequestRef.current += 1;
    };
  }, [connection.id]);

  useEffect(() => {
    const items = sourceType === "systemd" ? servicesCache.items : containersCache.items;
    const next = reconcileSelection(items, sourceId) ?? "";
    if (next === sourceId) return;
    setSourceId(next);
    onSourceChange(next ? { type: sourceType, id: next } : null);
  }, [sourceType, sourceId, servicesCache.items, containersCache.items]);

  useEffect(() => {
    let listenerDisposed = false;
    let unlisten: (() => void) | undefined;
    void listen<StreamStateEvent>("stream-state-changed", ({ payload }) => {
      applyStreamState(payload);
    })
      .then((dispose) => {
        if (listenerDisposed) dispose();
        else unlisten = dispose;
      })
      .catch((caught) => {
        if (!listenerDisposed) setError(`Log event listener failed: ${errorMessage(caught)}`);
      });
    return () => {
      listenerDisposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(search), 180);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    return () => {
      disposedRef.current = true;
      streamGenerationRef.current += 1;
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
      const streamId = streamIdRef.current;
      streamIdRef.current = null;
      if (streamId) void api.stopLogStream(streamId).catch(() => undefined);
    };
  }, []);

  async function stop(): Promise<boolean> {
    const streamId = streamIdRef.current;
    finishDecoder();
    drainPausedBuffer();
    streamGenerationRef.current += 1;
    startingRef.current = false;
    if (!streamId) {
      setStreamStatus("stopped");
      return true;
    }
    setStreamStatus("stopping");
    try {
      await api.stopLogStream(streamId);
      if (streamIdRef.current === streamId) streamIdRef.current = null;
      setStreamStatus("stopped");
      if (sourceId) onStreamLifecycle({ type: sourceType, id: sourceId }, false);
      return true;
    } catch (caught) {
      if (streamIdRef.current === streamId) setStreamStatus("running");
      setError(`Could not stop Log Stream: ${errorMessage(caught)}`);
      return false;
    }
  }

  async function start(sudoPassword: string | null = null) {
    if (!sourceId || !(await stop())) return;
    const generation = ++streamGenerationRef.current;
    setError(null);
    setSudoPurpose(null);
    setPaused(false);
    pausedRef.current = false;
    pausedBufferRef.current.clear();
    setStreamStatus("starting");
    startingRef.current = true;
    earlyStateRef.current.clear();
    decoderRef.current = new TextDecoder();
    const sourceName = sourceOptions.find((source) => source.id === sourceId);
    const label = sourceName && "name" in sourceName ? sourceName.name : sourceId;
    activeBufferRef.current.append(
      `${activeBufferRef.current.byteCount ? "\n" : ""}[${sourceType} ${label}] stream started\n`,
    );
    flushNow();

    const output = new Channel<ArrayBuffer>();
    output.onmessage = (message) => {
      if (disposedRef.current || generation !== streamGenerationRef.current) return;
      appendChunk(decoderRef.current.decode(new Uint8Array(message), { stream: true }));
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
      if (disposedRef.current || generation !== streamGenerationRef.current) {
        await api.stopLogStream(started.streamId).catch(() => undefined);
        return;
      }
      streamIdRef.current = started.streamId;
      startingRef.current = false;
      setStreamStatus("running");
      onStreamLifecycle({ type: sourceType, id: sourceId }, true);
      const earlyState = earlyStateRef.current.get(started.streamId);
      if (earlyState) {
        earlyStateRef.current.delete(started.streamId);
        applyStreamState(earlyState);
      }
    } catch (caught) {
      if (generation !== streamGenerationRef.current) return;
      const message = errorMessage(caught);
      startingRef.current = false;
      setError(message);
      setStreamStatus("stopped");
      if (message.toLowerCase().includes("permission denied")) setSudoPurpose("stream");
    }
  }

  function togglePause() {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (!next && pausedBufferRef.current.byteCount) {
      activeBufferRef.current.append(pausedBufferRef.current.snapshot());
      pausedBufferRef.current.clear();
      scheduleFlush();
    }
  }

  async function changeType(next: LogSourceType) {
    if (!(await stop())) return;
    setSourceType(next);
    const items = next === "systemd" ? servicesCache.items : containersCache.items;
    const nextId = items[0]?.id ?? "";
    setSourceId(nextId);
    onSourceChange(nextId ? { type: next, id: nextId } : null);
    void loadSources(next);
  }

  function clearBuffers() {
    activeBufferRef.current.clear();
    pausedBufferRef.current.clear();
    flushNow();
  }

  const displayedLogs = useMemo(() => {
    if (!searchQuery.trim()) return logs;
    const query = searchQuery.toLowerCase();
    return logs
      .split("\n")
      .filter((line) => line.toLowerCase().includes(query))
      .join("\n");
  }, [logs, searchQuery]);

  const sourceCache = sourceType === "systemd" ? servicesCache : containersCache;
  const sourceOptions = sourceCache.items;
  const controlsLocked = streamStatus !== "stopped";
  if (sourceCache.loading && !sourceCache.items.length)
    return <LoadingState label="Finding available log sources…" />;
  if (sourceCache.error && !sourceCache.items.length) {
    const dockerPermissionError =
      sourceType === "docker" && sourceCache.error.toLowerCase().includes("permission denied");
    return (
      <>
        <ErrorState
          message={sourceCache.error}
          action={
            dockerPermissionError ? (
              <button onClick={() => setSudoPurpose("sources")}>Retry with sudo</button>
            ) : (
              <button onClick={() => loadSources(sourceType, true)}>Retry</button>
            )
          }
        />
        {sudoPurpose === "sources" && (
          <CredentialDialog
            connectionLabel={connection.displayName}
            onClose={() => setSudoPurpose(null)}
            onSubmit={(password) => loadSources("docker", true, password)}
          />
        )}
      </>
    );
  }

  const statusLabel =
    streamStatus === "starting"
      ? "Starting stream"
      : streamStatus === "stopping"
        ? "Stopping stream"
        : streamStatus === "running"
          ? paused
            ? "Rendering paused"
            : "Stream active"
          : "Stream stopped";

  return (
    <section className="feature-page logs-page">
      <header className="page-heading compact-heading">
        <div>
          <h2>Logs</h2>
          <p role="status" aria-live="polite">
            {statusLabel}
          </p>
        </div>
        <div className="toolbar-actions">
          <button
            className="toolbar-button"
            type="button"
            onClick={() => start()}
            disabled={!sourceId || streamStatus !== "stopped"}
          >
            <Play size={14} /> Start
          </button>
          <button
            className="toolbar-button"
            type="button"
            onClick={togglePause}
            disabled={streamStatus !== "running"}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? "Resume" : "Pause"}
          </button>
          <button
            className="toolbar-button"
            type="button"
            onClick={() => stop()}
            disabled={streamStatus === "stopped" || streamStatus === "stopping"}
          >
            <Square size={13} /> Stop
          </button>
          <button className="toolbar-button" type="button" onClick={clearBuffers}>
            <Eraser size={14} /> Clear view
          </button>
        </div>
      </header>
      <div className="log-controls">
        <label>
          <span>Source</span>
          <select
            value={sourceType}
            onChange={(event) => void changeType(event.target.value as LogSourceType)}
            disabled={controlsLocked}
          >
            <option value="systemd">systemd</option>
            <option value="docker">Docker</option>
          </select>
        </label>
        <label className="source-select">
          <span>{sourceType === "systemd" ? "Unit" : "Container"}</span>
          <select
            value={sourceId}
            onChange={(event) => {
              setSourceId(event.target.value);
              onSourceChange({ type: sourceType, id: event.target.value });
            }}
            disabled={controlsLocked}
          >
            {sourceOptions.map((source) => (
              <option value={source.id} key={source.id}>
                {"name" in source ? source.name : source.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Lines</span>
          <select
            value={tail}
            onChange={(event) => setTail(Number(event.target.value))}
            disabled={controlsLocked}
          >
            {logTailOptions.map((count) => (
              <option key={count}>{count}</option>
            ))}
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
            disabled={controlsLocked}
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
      {sourceCache.error && (
        <p className="inline-warning">Showing saved sources. Refresh failed: {sourceCache.error}</p>
      )}
      {error && (
        <div className="inline-error" role="alert">
          <span>{error}</span>
          {error.toLowerCase().includes("permission denied") && (
            <button
              className="inline-action"
              type="button"
              onClick={() => setSudoPurpose("stream")}
            >
              Retry with sudo
            </button>
          )}
        </div>
      )}
      {displayedLogs ? (
        <pre className="log-output">{displayedLogs}</pre>
      ) : (
        <div className="log-output log-empty">
          <FileClock size={24} aria-hidden="true" />
          <p>
            {searchQuery.trim()
              ? "No loaded lines match your search."
              : sourceId
                ? "Press Start to stream this source's output here."
                : "Choose a source, then press Start to stream its output here."}
          </p>
        </div>
      )}
      {sudoPurpose && (
        <CredentialDialog
          connectionLabel={connection.displayName}
          onClose={() => setSudoPurpose(null)}
          onSubmit={(password) =>
            sudoPurpose === "sources" ? loadSources("docker", true, password) : start(password)
          }
        />
      )}
    </section>
  );
}
