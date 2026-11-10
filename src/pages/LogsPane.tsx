import { Search } from "../components/MagnifierIcon";
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowDown, Eraser, FileClock, Pause, Play, Square, WrapText, X } from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import { BoundedLogBuffer, logRenderDelay } from "../lib/log-buffer";
import {
  highlightSegments,
  LogLineCache,
  lineMatches,
  type LogLevelFilter,
  type ParsedLogLine,
} from "../lib/log-lines";
import { isCacheFresh, reconcileSelection } from "../lib/workspace-cache";
import { isSystemdUnitName } from "../lib/systemd-units";
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
type StreamTarget = { type: LogSourceType; id: string; tail: number; follow: boolean };
const MAX_EARLY_STREAM_EVENTS = 16;
const HELD_LINES_DELAY = 400;
const LEVEL_FILTERS: { value: LogLevelFilter; label: string; title?: string }[] = [
  { value: "all", label: "All" },
  {
    value: "warning",
    label: "Warnings",
    title: "Loaded lines with a warning level, or that mention warn, warning, or deprecated",
  },
  {
    value: "error",
    label: "Errors",
    title:
      "Loaded lines with an error level, or that mention error, failed, fatal, critical, panic, or exception",
  },
];
const numberFormat = new Intl.NumberFormat("en-US");

const CHUNK_LINES = 100;
const LINE_HEIGHT = 1.55;
type LogRowData = { number: number; line: ParsedLogLine };

function LogRow({ number, line, query }: LogRowData & { query: string }) {
  const parts = query ? highlightSegments(line.segments, query) : null;
  const content = line.segments.map((segment, index) => {
    const text = parts
      ? parts[index].map((part, partIndex) =>
          part.match ? <mark key={partIndex}>{part.text}</mark> : part.text,
        )
      : segment.text;
    // Message text stays unwrapped to keep large buffers light.
    return segment.role === "message" ? (
      <Fragment key={index}>{text}</Fragment>
    ) : (
      <span key={index} className={`log-${segment.role}`}>
        {text}
      </span>
    );
  });
  return (
    <div
      className="log-line"
      data-line={number}
      data-level={line.level ?? undefined}
      data-marker={line.marker || undefined}
    >
      {line.marker ? <span className="log-marker">{content}</span> : content}
    </div>
  );
}

/** Rows render in fixed blocks so a flush only re-renders the blocks it changed. */
const LogChunk = memo(
  function LogChunk({
    rows,
    query,
    estimatedHeight,
  }: {
    rows: LogRowData[];
    query: string;
    estimatedHeight: number;
  }) {
    return (
      <div
        className="log-chunk"
        style={{ containIntrinsicBlockSize: `auto ${Math.ceil(rows.length * estimatedHeight)}px` }}
      >
        {rows.map((row) => (
          <LogRow key={row.number} number={row.number} line={row.line} query={query} />
        ))}
      </div>
    );
  },
  (previous, next) =>
    previous.query === next.query &&
    previous.estimatedHeight === next.estimatedHeight &&
    previous.rows.length === next.rows.length &&
    previous.rows.every(
      (row, index) => row.number === next.rows[index].number && row.line === next.rows[index].line,
    ),
);

function chunkRows(rows: LogRowData[]): { key: number; rows: LogRowData[] }[] {
  const chunks: { key: number; rows: LogRowData[] }[] = [];
  for (const row of rows) {
    const key = Math.floor((row.number - 1) / CHUNK_LINES);
    const last = chunks.at(-1);
    if (last?.key === key) last.rows.push(row);
    else chunks.push({ key, rows: [row] });
  }
  return chunks;
}

export function LogsPane({
  connection,
  windowsHost = false,
  settings,
  logTailOptions,
  servicesCache,
  containersCache,
  selectedSource,
  onServicesCacheChange,
  onContainersCacheChange,
  onSourceChange,
}: {
  connection: SavedConnection;
  windowsHost?: boolean;
  settings: AppSettings;
  logTailOptions: number[];
  servicesCache: CachedList<SystemdUnit>;
  containersCache: CachedList<DockerContainer>;
  selectedSource: LogSourceSelection | null;
  onServicesCacheChange: (cache: CachedList<SystemdUnit>) => void;
  onContainersCacheChange: (cache: CachedList<DockerContainer>) => void;
  onSourceChange: (source: LogSourceSelection | null) => void;
}) {
  const [sourceType, setSourceType] = useState<LogSourceType>(
    windowsHost ? "docker" : (selectedSource?.type ?? "systemd"),
  );
  const [sourceId, setSourceId] = useState(selectedSource?.id ?? "");
  const explicitSystemdSource =
    sourceType === "systemd" &&
    selectedSource?.type === "systemd" &&
    sourceId === selectedSource.id &&
    isSystemdUnitName(sourceId);
  const [tail, setTail] = useState(settings.defaultLogTail);
  const [follow, setFollow] = useState(true);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("stopped");
  const [paused, setPaused] = useState(false);
  const [logs, setLogs] = useState({ text: "", firstLine: 1 });
  const [heldLines, setHeldLines] = useState(0);
  const [levelFilter, setLevelFilter] = useState<LogLevelFilter>("all");
  const [search, setSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [atLatest, setAtLatest] = useState(true);
  const [unreadLines, setUnreadLines] = useState(0);
  const [wrapLines, setWrapLines] = useState(true);
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
  const heldTimerRef = useRef<number | null>(null);
  const lineCacheRef = useRef(new LogLineCache());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const disposedRef = useRef(false);
  const startingRef = useRef(false);
  // The newest Start request wins; superseded requests exit after their stop.
  const startRequestRef = useRef(0);
  // Whether the reader wants a stream running, independent of render timing.
  const wantsStreamRef = useRef(false);
  const earlyStateRef = useRef(new Map<string, StreamStateEvent>());
  const outputRef = useRef<HTMLDivElement>(null);
  const previousLastLineRef = useRef(0);
  const servicesCacheRef = useRef(servicesCache);
  const containersCacheRef = useRef(containersCache);
  servicesCacheRef.current = servicesCache;
  containersCacheRef.current = containersCache;

  function flushNow() {
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
    setLogs({
      text: activeBufferRef.current.snapshot(),
      firstLine: activeBufferRef.current.firstLineNumber,
    });
  }

  function scheduleFlush() {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(
      flushNow,
      logRenderDelay(activeBufferRef.current.byteCount),
    );
  }

  function clearHeldLines() {
    if (heldTimerRef.current !== null) window.clearTimeout(heldTimerRef.current);
    heldTimerRef.current = null;
    setHeldLines(0);
  }

  function appendChunk(chunk: string) {
    if (!chunk) return;
    if (pausedRef.current) {
      pausedBufferRef.current.append(chunk);
      heldTimerRef.current ??= window.setTimeout(() => {
        heldTimerRef.current = null;
        if (pausedRef.current) setHeldLines(pausedBufferRef.current.lineCount);
      }, HELD_LINES_DELAY);
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
    clearHeldLines();
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
      wantsStreamRef.current = false;
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
    if (explicitSystemdSource) return;
    const items = sourceType === "systemd" ? servicesCache.items : containersCache.items;
    const next = reconcileSelection(items, sourceId) ?? "";
    if (next === sourceId) return;
    setSourceId(next);
    onSourceChange(next ? { type: sourceType, id: next } : null);
    showSource(sourceType, next);
  }, [sourceType, sourceId, servicesCache.items, containersCache.items, explicitSystemdSource]);

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
    function keydown(event: KeyboardEvent) {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key.toLowerCase() !== "f")
        return;
      if (document.querySelector('[role="dialog"]:not([inert])')) return;
      const input = searchInputRef.current;
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  useEffect(() => {
    return () => {
      disposedRef.current = true;
      streamGenerationRef.current += 1;
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
      if (heldTimerRef.current !== null) window.clearTimeout(heldTimerRef.current);
      const streamId = streamIdRef.current;
      streamIdRef.current = null;
      if (streamId) void api.stopLogStream(streamId).catch(() => undefined);
    };
  }, []);

  async function stop(): Promise<boolean> {
    // Claim the stream so an overlapping stop or restart never stops it twice.
    const streamId = streamIdRef.current;
    streamIdRef.current = null;
    finishDecoder();
    drainPausedBuffer();
    const generation = ++streamGenerationRef.current;
    startingRef.current = false;
    if (!streamId) {
      setStreamStatus("stopped");
      return true;
    }
    setStreamStatus("stopping");
    try {
      await api.stopLogStream(streamId);
    } catch (caught) {
      const message = errorMessage(caught);
      // The stream already ended; its state event may still be on the way.
      if (!/no longer active/i.test(message)) {
        if (generation === streamGenerationRef.current && streamIdRef.current === null) {
          streamIdRef.current = streamId;
          setStreamStatus("running");
        }
        setError(`Could not stop Log Stream: ${message}`);
        return false;
      }
    }
    if (generation === streamGenerationRef.current) setStreamStatus("stopped");
    return true;
  }

  /** Stops at the reader's request and cancels any Start still in progress. */
  function stopStream() {
    wantsStreamRef.current = false;
    startRequestRef.current += 1;
    return stop();
  }

  async function start(
    sudoPassword: string | null = null,
    target: StreamTarget = { type: sourceType, id: sourceId, tail, follow },
    fresh = false,
  ) {
    if (!target.id) return;
    const request = ++startRequestRef.current;
    wantsStreamRef.current = true;
    const stopped = await stop();
    if (request !== startRequestRef.current || disposedRef.current) return;
    if (!stopped) return;
    // A different source or line count starts in an empty view; stop() may have
    // drained held or partial lines from the previous stream.
    if (fresh) clearBuffers();
    const generation = ++streamGenerationRef.current;
    setError(null);
    setSudoPurpose(null);
    setPaused(false);
    pausedRef.current = false;
    pausedBufferRef.current.clear();
    clearHeldLines();
    setStreamStatus("starting");
    startingRef.current = true;
    earlyStateRef.current.clear();
    decoderRef.current = new TextDecoder();
    const targetItems = target.type === "systemd" ? servicesCache.items : containersCache.items;
    activeBufferRef.current.append(
      `${activeBufferRef.current.byteCount ? "\n" : ""}[${target.type} ${sourceLabel(targetItems, target.id)}] stream started\n`,
    );
    flushNow();

    const output = new Channel<ArrayBuffer>();
    output.onmessage = (message) => {
      if (disposedRef.current || generation !== streamGenerationRef.current) return;
      appendChunk(decoderRef.current.decode(new Uint8Array(message), { stream: true }));
    };

    try {
      const started =
        target.type === "systemd"
          ? await api.startJournalStream(
              connection.id,
              target.id,
              target.tail,
              target.follow,
              sudoPassword,
              output,
            )
          : await api.startDockerLogStream(
              connection.id,
              target.id,
              target.tail,
              target.follow,
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
      const earlyState = earlyStateRef.current.get(started.streamId);
      if (earlyState) {
        earlyStateRef.current.delete(started.streamId);
        applyStreamState(earlyState);
      }
    } catch (caught) {
      if (generation !== streamGenerationRef.current) return;
      const message = errorMessage(caught);
      wantsStreamRef.current = false;
      startingRef.current = false;
      setError(message);
      setStreamStatus("stopped");
      if (!windowsHost && message.toLowerCase().includes("permission denied"))
        setSudoPurpose("stream");
    }
  }

  function togglePause() {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (!next) clearHeldLines();
    if (!next && pausedBufferRef.current.byteCount) {
      activeBufferRef.current.append(pausedBufferRef.current.snapshot());
      pausedBufferRef.current.clear();
      scheduleFlush();
    }
  }

  const streaming = streamStatus === "running" || streamStatus === "starting";

  /** The view shows one source; a different source starts from an empty view. */
  function showSource(type: LogSourceType, id: string) {
    clearBuffers();
    setError(null);
    if (!wantsStreamRef.current) return;
    if (id) void start(null, { type, id, tail, follow }, true);
    else void stopStream();
  }

  function selectSource(id: string) {
    if (id === sourceId) return;
    setSourceId(id);
    onSourceChange({ type: sourceType, id });
    showSource(sourceType, id);
  }

  function changeType(next: LogSourceType) {
    if (next === sourceType) return;
    const items = next === "systemd" ? servicesCache.items : containersCache.items;
    const nextId = items[0]?.id ?? "";
    setSourceType(next);
    setSourceId(nextId);
    onSourceChange(nextId ? { type: next, id: nextId } : null);
    void loadSources(next);
    showSource(next, nextId);
  }

  /** Line count and follow changes reread the same source. */
  function changeReadOptions(options: { tail: number; follow: boolean }) {
    if (wantsStreamRef.current)
      void start(null, { type: sourceType, id: sourceId, ...options }, true);
  }

  function clearBuffers() {
    activeBufferRef.current.clear();
    pausedBufferRef.current.clear();
    clearHeldLines();
    flushNow();
    setAtLatest(true);
    setUnreadLines(0);
  }

  function clearSearch() {
    setSearch("");
    setSearchQuery("");
  }

  const lines = useMemo(() => {
    const raw = logs.text.split("\n");
    if (raw.at(-1) === "") raw.pop();
    const cache = lineCacheRef.current;
    return raw.map((text, index) => ({ number: logs.firstLine + index, line: cache.get(text) }));
  }, [logs]);
  const levelCounts = useMemo(() => {
    const counts = { all: 0, warning: 0, error: 0 };
    for (const { line } of lines) {
      if (line.marker) continue;
      counts.all += 1;
      if (line.level) counts[line.level] += 1;
    }
    return counts;
  }, [lines]);
  const query = searchQuery.trim();
  const filtering = Boolean(query) || levelFilter !== "all";
  const visibleLines = useMemo(
    () =>
      filtering
        ? lines.filter(({ line }) => !line.marker && lineMatches(line, query, levelFilter))
        : lines,
    [lines, query, levelFilter, filtering],
  );
  const visibleChunks = useMemo(() => chunkRows(visibleLines), [visibleLines]);
  const lastLine = logs.firstLine + lines.length - 1;
  const gutterDigits = Math.max(3, String(Math.max(lastLine, 1)).length);

  useLayoutEffect(() => {
    const added = Math.max(0, lastLine - previousLastLineRef.current);
    previousLastLineRef.current = lastLine;
    const output = outputRef.current;
    if (!output || filtering) return;
    if (atLatest) {
      output.scrollTop = output.scrollHeight;
      setUnreadLines(0);
    } else if (added > 0) {
      setUnreadLines((current) => current + added);
    }
  }, [lastLine, logs, filtering, atLatest]);

  function handleOutputScroll() {
    const output = outputRef.current;
    if (!output) return;
    const latest = output.scrollHeight - output.scrollTop - output.clientHeight <= 24;
    setAtLatest(latest);
    if (latest) setUnreadLines(0);
  }

  function jumpToLatest() {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
    setAtLatest(true);
    setUnreadLines(0);
  }

  const sourceCache = sourceType === "systemd" ? servicesCache : containersCache;
  const sourceOptions = sourceCache.items;
  if (sourceCache.loading && !sourceCache.items.length && !explicitSystemdSource)
    return <LoadingState label="Finding available log sources…" />;
  if (sourceCache.error && !sourceCache.items.length && !explicitSystemdSource) {
    const dockerPermissionError =
      !windowsHost &&
      sourceType === "docker" &&
      sourceCache.error.toLowerCase().includes("permission denied");
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

  const sourceNoun = sourceType === "systemd" ? "unit" : "container";
  const selectedLabel = sourceId ? sourceLabel(sourceOptions, sourceId) : "";
  const statusLabel =
    streamStatus === "starting"
      ? "Starting…"
      : streamStatus === "stopping"
        ? "Stopping…"
        : streamStatus === "running"
          ? paused
            ? "Paused"
            : "Streaming"
          : "Stopped";
  const statusTone =
    streamStatus === "running"
      ? paused
        ? "status-paused"
        : "status-connected"
      : streamStatus === "stopped"
        ? "status-disconnected"
        : "status-connecting";

  return (
    <section className="feature-page logs-page">
      <header className="page-heading compact-heading">
        <div>
          <h2>Logs</h2>
          <p className="log-status">
            <span className={`status-dot ${statusTone}`} aria-hidden="true" />
            <span role="status" aria-live="polite">
              {statusLabel}
            </span>
            {streamStatus === "running" && paused && heldLines > 0 && (
              <span className="log-status-detail">
                {numberFormat.format(heldLines)} new {heldLines === 1 ? "line" : "lines"} waiting
              </span>
            )}
          </p>
        </div>
      </header>
      <div className="log-controls">
        <label>
          <span>Source</span>
          <select
            value={sourceType}
            onChange={(event) => changeType(event.target.value as LogSourceType)}
          >
            {!windowsHost && <option value="systemd">systemd</option>}
            <option value="docker">Docker</option>
          </select>
        </label>
        <label className="source-select">
          <span>{sourceType === "systemd" ? "Unit" : "Container"}</span>
          <select
            value={sourceId}
            onChange={(event) => selectSource(event.target.value)}
            disabled={!sourceId}
          >
            {!sourceId && <option value="">No {sourceNoun}s found</option>}
            {explicitSystemdSource && !sourceOptions.some((source) => source.id === sourceId) && (
              <option value={sourceId}>{sourceId}</option>
            )}
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
            onChange={(event) => {
              const next = Number(event.target.value);
              setTail(next);
              changeReadOptions({ tail: next, follow });
            }}
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
            onChange={(event) => {
              const next = event.target.checked;
              setFollow(next);
              changeReadOptions({ tail, follow: next });
            }}
          />{" "}
          Receive new lines
        </label>
        <div className="log-transport">
          <button
            className="secondary-button compact-button log-start"
            type="button"
            onClick={() => void (streamStatus === "stopped" ? start() : stopStream())}
            disabled={streamStatus === "stopping" || (streamStatus === "stopped" && !sourceId)}
          >
            {streamStatus === "stopped" ? <Play size={14} /> : <Square size={13} />}
            {streamStatus === "stopped" ? "Start" : "Stop"}
          </button>
          <button
            className="toolbar-button"
            type="button"
            onClick={togglePause}
            disabled={streamStatus !== "running"}
            title={paused ? undefined : "Hold new lines while you read. The stream keeps running."}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>
      {sourceCache.error && (
        <p className="inline-warning">Showing saved sources. Refresh failed: {sourceCache.error}</p>
      )}
      {error && (
        <div className="inline-error" role="alert">
          <span>{error}</span>
          {!windowsHost && error.toLowerCase().includes("permission denied") && (
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
      <div className="log-panel">
        <div className="log-view-bar">
          <label className="search-field log-search">
            <Search size={15} />
            <input
              ref={searchInputRef}
              value={search}
              aria-label="Search loaded lines"
              aria-keyshortcuts="Control+F"
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !search) return;
                event.preventDefault();
                event.stopPropagation();
                clearSearch();
              }}
              placeholder="Search loaded lines"
            />
            {query && (
              <span className="log-match-count" aria-live="polite">
                {numberFormat.format(visibleLines.length)}{" "}
                {visibleLines.length === 1 ? "match" : "matches"}
              </span>
            )}
            {search && (
              <button
                className="log-search-clear"
                type="button"
                aria-label="Clear search"
                title="Clear search (Esc)"
                onClick={() => {
                  clearSearch();
                  searchInputRef.current?.focus();
                }}
              >
                <X size={13} />
              </button>
            )}
          </label>
          <div className="log-view-tools">
            <div className="log-level-filter" role="group" aria-label="Show lines">
              {LEVEL_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={levelFilter === filter.value}
                  data-level={filter.value}
                  data-found={levelCounts[filter.value] > 0 || undefined}
                  title={filter.title}
                  onClick={() => setLevelFilter(filter.value)}
                >
                  {filter.label}
                  <span className="log-count">
                    {numberFormat.format(levelCounts[filter.value])}
                  </span>
                </button>
              ))}
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="Wrap lines"
              title="Wrap lines"
              aria-pressed={wrapLines}
              onClick={() => setWrapLines((current) => !current)}
            >
              <WrapText size={15} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="Clear view"
              title="Clear view"
              disabled={!lines.length}
              onClick={clearBuffers}
            >
              <Eraser size={15} />
            </button>
          </div>
        </div>
        {visibleLines.length ? (
          <div className="log-output-shell">
            <div
              ref={outputRef}
              className={wrapLines ? "log-output log-output-wrapped" : "log-output"}
              role="log"
              aria-live="off"
              aria-label={selectedLabel ? `Log output for ${selectedLabel}` : "Log output"}
              tabIndex={0}
              style={
                {
                  fontFamily: settings.terminalFontFamily,
                  fontSize: settings.terminalFontSize,
                  "--log-gutter": `${gutterDigits}ch`,
                } as CSSProperties
              }
              onScroll={handleOutputScroll}
            >
              <div className="log-lines">
                {visibleChunks.map((chunk) => (
                  <LogChunk
                    key={chunk.key}
                    rows={chunk.rows}
                    query={query}
                    estimatedHeight={settings.terminalFontSize * LINE_HEIGHT}
                  />
                ))}
              </div>
            </div>
            {!filtering && !atLatest && (
              <button className="log-jump-latest" type="button" onClick={jumpToLatest}>
                <ArrowDown size={14} />
                Jump to latest
                {unreadLines > 0 && (
                  <span className="log-count">{numberFormat.format(unreadLines)} new</span>
                )}
              </button>
            )}
          </div>
        ) : (
          <div className="log-empty">
            <FileClock size={24} aria-hidden="true" />
            {filtering && lines.length ? (
              <>
                <p>
                  {query
                    ? `No loaded ${levelFilter === "all" ? "" : `${levelFilter} `}lines match “${query}”.`
                    : `No loaded lines mention ${levelFilter === "error" ? "errors" : "warnings"}.`}
                </p>
                <button
                  className="inline-action"
                  type="button"
                  onClick={() => {
                    clearSearch();
                    setLevelFilter("all");
                  }}
                >
                  Show all lines
                </button>
              </>
            ) : (
              <p>
                {streaming
                  ? `Waiting for output from ${selectedLabel}…`
                  : sourceId
                    ? `Start reads the last ${tail} lines of ${selectedLabel}${follow ? ", then new lines as they arrive" : ""}.`
                    : `Choose a ${sourceNoun} to read its logs.`}
              </p>
            )}
          </div>
        )}
      </div>
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

function sourceLabel(items: (SystemdUnit | DockerContainer)[], id: string): string {
  const item = items.find((source) => source.id === id);
  return item && "name" in item ? item.name : id;
}
