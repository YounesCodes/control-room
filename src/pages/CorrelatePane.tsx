import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Eraser, Layers, Pause, Play, Plus, X } from "lucide-react";
import { EmptyState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import { logRenderDelay } from "../lib/log-buffer";
import {
  MAX_MERGED_LINES,
  SourceLineBuffer,
  droppedNotice,
  formatLineTime,
  mergeSources,
  skewNotice,
  sourceLabel,
  timeQualifier,
} from "../lib/log-correlation";
import { isCacheFresh } from "../lib/workspace-cache";
import type {
  AppSettings,
  CachedList,
  CorrelatedLine,
  CorrelationSource,
  DockerContainer,
  LogSourceType,
  SavedConnection,
  StreamStateEvent,
  SystemdUnit,
} from "../types";

const MAX_SOURCES = 6;

interface CorrelatePaneProps {
  connection: SavedConnection;
  settings: AppSettings;
  logTailOptions: number[];
  servicesCache: CachedList<SystemdUnit>;
  containersCache: CachedList<DockerContainer>;
  onServicesCacheChange: (cache: CachedList<SystemdUnit>) => void;
  onContainersCacheChange: (cache: CachedList<DockerContainer>) => void;
}

// Correlation consumes existing Log Streams. It starts no command of its own,
// never restarts or couples the streams it reads, and holds every line in
// memory only.
export function CorrelatePane({
  connection,
  settings,
  logTailOptions,
  servicesCache,
  containersCache,
  onServicesCacheChange,
  onContainersCacheChange,
}: CorrelatePaneProps) {
  const [sources, setSources] = useState<CorrelationSource[]>([]);
  const [hiddenSourceIds, setHiddenSourceIds] = useState<string[]>([]);
  const [draftType, setDraftType] = useState<LogSourceType>("systemd");
  const [draftTarget, setDraftTarget] = useState("");
  const [tail, setTail] = useState(settings.defaultLogTail);
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState<CorrelatedLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const buffersRef = useRef(new Map<string, SourceLineBuffer>());
  const arrivalRef = useRef(0);
  const pausedRef = useRef(false);
  const flushTimerRef = useRef<number | null>(null);
  const hiddenRef = useRef<string[]>([]);
  const disposedRef = useRef(false);
  const decodersRef = useRef(new Map<string, TextDecoder>());
  const sourcesRef = useRef<CorrelationSource[]>([]);
  const servicesRef = useRef(servicesCache);
  const containersRef = useRef(containersCache);
  sourcesRef.current = sources;
  hiddenRef.current = hiddenSourceIds;
  pausedRef.current = paused;
  servicesRef.current = servicesCache;
  containersRef.current = containersCache;

  const visibleSourceIds = useMemo(
    () =>
      sources.filter((source) => !hiddenSourceIds.includes(source.id)).map((source) => source.id),
    [sources, hiddenSourceIds],
  );

  function recompute() {
    const buffers = sourcesRef.current
      .map((source) => buffersRef.current.get(source.id))
      .filter((buffer): buffer is SourceLineBuffer => Boolean(buffer));
    const visible = sourcesRef.current
      .filter((source) => !hiddenRef.current.includes(source.id))
      .map((source) => source.id);
    setLines(mergeSources(buffers, visible));
  }

  function scheduleFlush() {
    if (pausedRef.current || flushTimerRef.current !== null) return;
    const total = buffersRef.current.size * 64 * 1024;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      if (!disposedRef.current) recompute();
    }, logRenderDelay(total));
  }

  useEffect(() => {
    recompute();
  }, [visibleSourceIds.join(",")]);

  useEffect(() => {
    disposedRef.current = false;
    let dispose: (() => void) | undefined;
    void listen<StreamStateEvent>("stream-state-changed", ({ payload }) => {
      setSources((current) =>
        current.map((source) =>
          source.streamId === payload.streamId
            ? {
                ...source,
                state:
                  payload.state === "running"
                    ? "running"
                    : payload.state === "error"
                      ? "error"
                      : "stopped",
                error: payload.reason,
                streamId: payload.state === "running" ? source.streamId : null,
              }
            : source,
        ),
      );
    })
      .then((unlisten) => {
        if (disposedRef.current) unlisten();
        else dispose = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposedRef.current = true;
      dispose?.();
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
      for (const source of sourcesRef.current) {
        if (source.streamId) void api.stopLogStream(source.streamId).catch(() => undefined);
      }
      buffersRef.current.clear();
      decodersRef.current.clear();
    };
  }, []);

  async function loadSources(type: LogSourceType) {
    const cache = type === "systemd" ? servicesRef.current : containersRef.current;
    if (isCacheFresh(cache)) return;
    try {
      if (type === "systemd") {
        const items = await api.listServices(connection.id);
        onServicesCacheChange({ items, fetchedAt: Date.now(), loading: false, error: null });
      } else {
        const items = await api.listContainers(connection.id);
        onContainersCacheChange({ items, fetchedAt: Date.now(), loading: false, error: null });
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  useEffect(() => {
    void loadSources("systemd");
    void loadSources("docker");
  }, [connection.id]);

  const options =
    draftType === "systemd"
      ? servicesCache.items.map((unit) => ({ id: unit.id, name: unit.id }))
      : containersCache.items.map((container) => ({ id: container.id, name: container.name }));

  async function addSource() {
    const target = draftTarget || options[0]?.id;
    if (!target) return;
    if (sources.length >= MAX_SOURCES) {
      setError(`Correlate at most ${MAX_SOURCES} sources at once.`);
      return;
    }
    const label = options.find((option) => option.id === target)?.name ?? target;
    if (sources.some((source) => source.type === draftType && source.target === target)) {
      setError(`${label} is already in this correlation.`);
      return;
    }
    setError(null);
    const source: CorrelationSource = {
      id: crypto.randomUUID(),
      type: draftType,
      target,
      label,
      streamId: null,
      state: "starting",
      error: null,
    };
    buffersRef.current.set(source.id, new SourceLineBuffer(source.id));
    decodersRef.current.set(source.id, new TextDecoder());
    setSources((current) => [...current, source]);

    const output = new Channel<ArrayBuffer>();
    output.onmessage = (message) => {
      if (disposedRef.current) return;
      const decoder = decodersRef.current.get(source.id);
      const buffer = buffersRef.current.get(source.id);
      if (!decoder || !buffer) return;
      buffer.append(
        decoder.decode(new Uint8Array(message), { stream: true }),
        () => ++arrivalRef.current,
      );
      scheduleFlush();
    };

    try {
      const started =
        source.type === "systemd"
          ? await api.startJournalStream(connection.id, target, tail, true, null, output)
          : await api.startDockerLogStream(connection.id, target, tail, true, null, output, true);
      if (disposedRef.current) {
        await api.stopLogStream(started.streamId).catch(() => undefined);
        return;
      }
      setSources((current) =>
        current.map((item) =>
          item.id === source.id
            ? { ...item, streamId: started.streamId, state: "running", error: null }
            : item,
        ),
      );
    } catch (caught) {
      // One source failing leaves every other stream and its buffer untouched.
      setSources((current) =>
        current.map((item) =>
          item.id === source.id
            ? { ...item, state: "error", error: errorMessage(caught), streamId: null }
            : item,
        ),
      );
    }
  }

  async function removeSource(id: string) {
    const source = sourcesRef.current.find((item) => item.id === id);
    if (source?.streamId) await api.stopLogStream(source.streamId).catch(() => undefined);
    buffersRef.current.delete(id);
    decodersRef.current.delete(id);
    setSources((current) => current.filter((item) => item.id !== id));
    setHiddenSourceIds((current) => current.filter((item) => item !== id));
    recompute();
  }

  function toggleVisible(id: string) {
    setHiddenSourceIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function togglePause() {
    setPaused((current) => {
      const next = !current;
      pausedRef.current = next;
      if (!next) recompute();
      return next;
    });
  }

  function clearView() {
    for (const buffer of buffersRef.current.values()) buffer.clear();
    setLines([]);
  }

  const buffers = sources
    .map((source) => buffersRef.current.get(source.id))
    .filter((buffer): buffer is SourceLineBuffer => Boolean(buffer));
  const skew = skewNotice(sources);
  const dropped = droppedNotice(buffers);
  const labels = new Map(sources.map((source) => [source.id, sourceLabel(source)]));

  return (
    <section className="feature-page correlate-page">
      <header className="page-heading">
        <div>
          <h2>Correlate</h2>
          <p>
            {sources.length} of {MAX_SOURCES} sources · {lines.length} lines
          </p>
          <small className="unit-scope-note">
            Merged in memory only. Control Room never stores fetched log lines.
          </small>
        </div>
        <div className="correlate-controls">
          <button
            className="icon-button"
            type="button"
            onClick={togglePause}
            aria-label={paused ? "Resume merged view" : "Pause merged view"}
            title={paused ? "Resume merged view" : "Pause merged view (streams keep running)"}
            disabled={!sources.length}
          >
            {paused ? <Play size={16} /> : <Pause size={16} />}
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={clearView}
            aria-label="Clear merged view"
            disabled={!lines.length}
          >
            <Eraser size={16} />
          </button>
        </div>
      </header>

      <div className="correlate-add">
        <select
          value={draftType}
          onChange={(event) => {
            setDraftType(event.target.value as LogSourceType);
            setDraftTarget("");
          }}
          aria-label="Source type"
        >
          <option value="systemd">Systemd unit</option>
          <option value="docker">Container</option>
        </select>
        <select
          value={draftTarget}
          onChange={(event) => setDraftTarget(event.target.value)}
          aria-label="Source"
        >
          <option value="">{options.length ? "Choose a source" : "No sources available"}</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        <select
          value={tail}
          onChange={(event) => setTail(Number(event.target.value))}
          aria-label="Tail size"
        >
          {logTailOptions.map((count) => (
            <option key={count}>{count}</option>
          ))}
        </select>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void addSource()}
          disabled={!options.length || sources.length >= MAX_SOURCES}
        >
          <Plus size={15} /> Add source
        </button>
      </div>

      {error && <p className="inline-error">{error}</p>}
      {skew && <p className="inline-warning">{skew}</p>}
      {dropped && <p className="inline-warning">{dropped}</p>}

      {!!sources.length && (
        <ul className="correlate-sources">
          {sources.map((source) => (
            <li key={source.id}>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={!hiddenSourceIds.includes(source.id)}
                  onChange={() => toggleVisible(source.id)}
                />{" "}
                <code>{sourceLabel(source)}</code>
              </label>
              <span className={`correlate-state correlate-state-${source.state}`}>
                {source.state}
              </span>
              {source.error && <small>{source.error}</small>}
              <button
                className="icon-button"
                type="button"
                onClick={() => void removeSource(source.id)}
                aria-label={`Remove ${sourceLabel(source)}`}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {!sources.length ? (
        <EmptyState title="No sources yet">
          Add a journal or container stream, then another, to read them as one timeline.
        </EmptyState>
      ) : (
        <div className="correlate-lines" aria-live="off">
          {paused && <p className="inline-warning">Paused. The streams keep running.</p>}
          {!lines.length && <p className="correlate-empty">Waiting for lines.</p>}
          {lines.map((line) => {
            const qualifier = timeQualifier(line);
            return (
              <div className="correlate-line" key={line.key}>
                <time>{formatLineTime(line)}</time>
                <span className="correlate-line-source">{labels.get(line.sourceId)}</span>
                <span className="correlate-line-message">{line.message}</span>
                {(qualifier || line.late) && (
                  <span className="correlate-line-flags">
                    {line.late && (
                      <em title="Arrived after later lines were already shown">late</em>
                    )}
                    {qualifier && <em>{qualifier}</em>}
                  </span>
                )}
              </div>
            );
          })}
          {lines.length >= MAX_MERGED_LINES && (
            <p className="correlate-empty">
              Showing the newest {MAX_MERGED_LINES} merged lines. Older lines were dropped.
            </p>
          )}
        </div>
      )}
      <p className="correlate-footer">
        <Layers size={13} aria-hidden="true" /> Each source keeps its own stream and error state.
        Removing one leaves the others running.
      </p>
    </section>
  );
}
