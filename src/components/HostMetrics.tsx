import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  Circle,
  CircleAlert,
  CircleDashed,
  Clock3,
  ChevronDown,
  Pause,
  RefreshCw,
  X,
} from "lucide-react";
import { useHeaderMetrics } from "../hooks/use-header-metrics";
import { usePopoverExit } from "../hooks/use-popover-exit";
import { AnimatedNumber } from "./AnimatedNumber";
import {
  HEADER_METRIC_LABELS,
  formatReadingTime,
  headerMetricDetail,
  headerMetricValue,
  headerMetricNumber,
  formatByteRate,
  formatPercent,
  formatUptime,
} from "../lib/header-metrics";
import {
  CHART_HEIGHT,
  CHART_WIDTH,
  DEFAULT_METRIC_RANGE,
  METRIC_RANGES,
  areaPath,
  chartPoint,
  coveredSeconds,
  formatCoverage,
  missingReadingGap,
  peakReading,
  rateScale,
  readingsInRange,
  tracePath,
  traceSegments,
  type MetricRangeSeconds,
  type ReadingValue,
  type TimedReading,
} from "../lib/metric-history";
import type { HeaderMetric, HeaderMetrics } from "../types";

const PERCENT_METRICS = new Set<HeaderMetric>(["cpu", "ram", "gpu", "disk"]);

function validRate(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

const readRate: ReadingValue = (sample) => validRate(sample.diskReadBytesPerSecond);
const writeRate: ReadingValue = (sample) => validRate(sample.diskWriteBytesPerSecond);

function chartTraces(metric: HeaderMetric): { value: ReadingValue; kind: "main" | "read" }[] {
  if (metric === "diskIo")
    return [
      { value: readRate, kind: "read" },
      { value: writeRate, kind: "main" },
    ];
  return [{ value: (sample) => headerMetricNumber(metric, sample), kind: "main" }];
}

function MetricValue({
  metric,
  sample,
  animate,
  compact = false,
  fallback = "Unavailable",
}: {
  metric: HeaderMetric;
  sample: HeaderMetrics | null;
  animate: boolean;
  compact?: boolean;
  fallback?: string;
}) {
  const number = headerMetricNumber(metric, sample);
  const shared = { animate, accessible: !compact, dragRegion: compact, fallback };
  if (metric === "diskIo" && number !== null)
    return (
      <>
        <span className="host-metric-direction" data-tauri-drag-region={compact || undefined}>
          {compact ? "R" : "Read"}
        </span>{" "}
        <AnimatedNumber
          {...shared}
          value={sample?.diskReadBytesPerSecond}
          format={formatByteRate}
        />{" "}
        <span className="host-metric-direction" data-tauri-drag-region={compact || undefined}>
          {compact ? "W" : "Write"}
        </span>{" "}
        <AnimatedNumber
          {...shared}
          value={sample?.diskWriteBytesPerSecond}
          format={formatByteRate}
        />
      </>
    );
  return (
    <AnimatedNumber
      {...shared}
      value={metric === "uptime" ? sample?.uptimeSeconds : number}
      format={metric === "uptime" ? formatUptime : formatPercent}
    />
  );
}

function MetricChart({
  metric,
  readings,
  end,
  rangeSeconds,
  rangeLabel,
  gap,
}: {
  metric: HeaderMetric;
  readings: TimedReading[];
  end: number;
  rangeSeconds: number;
  rangeLabel: string;
  gap: number;
}) {
  const traces = chartTraces(metric);
  const peak = peakReading(readings, ...traces.map((trace) => trace.value));
  const percent = PERCENT_METRICS.has(metric);
  const frame = {
    start: end - rangeSeconds * 1000,
    rangeSeconds,
    max: percent ? 100 : rateScale(peak),
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
  };
  const peakText = peak === null ? null : percent ? formatPercent(peak) : formatByteRate(peak);
  const latest = readings.at(-1);
  const main = traces.find((trace) => trace.kind === "main")!;
  const latestValue = latest ? main.value(latest.sample) : null;
  const dot =
    latest && latestValue !== null
      ? chartPoint({ at: latest.at, value: latestValue }, frame)
      : null;
  const label = HEADER_METRIC_LABELS[metric];
  return (
    <div
      className="metric-chart"
      role="img"
      aria-label={`${label} over the last ${rangeLabel}, ${peakText ? `peak ${peakText}` : "no readings"}`}
    >
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <line
          className="metric-chart-guide"
          x1="0"
          x2={CHART_WIDTH}
          y1={CHART_HEIGHT / 2}
          y2={CHART_HEIGHT / 2}
        />
        <line
          className="metric-chart-baseline"
          x1="0"
          x2={CHART_WIDTH}
          y1={CHART_HEIGHT - 0.5}
          y2={CHART_HEIGHT - 0.5}
        />
        {traces.map((trace) =>
          traceSegments(readings, trace.value, gap).map((segment) => (
            <g key={`${trace.kind}:${segment[0].at}`} data-trace={trace.kind}>
              {trace.kind === "main" && (
                <path className="metric-chart-area" d={areaPath(segment, frame)} />
              )}
              <path className="metric-chart-line" d={tracePath(segment, frame)} />
            </g>
          )),
        )}
      </svg>
      {dot && (
        <span
          className="metric-chart-dot"
          aria-hidden="true"
          style={{
            left: `${(dot.x / CHART_WIDTH) * 100}%`,
            top: `${(dot.y / CHART_HEIGHT) * 100}%`,
          }}
        />
      )}
      {peakText && (
        <span className="metric-chart-peak" aria-hidden="true">
          peak {peakText}
        </span>
      )}
    </div>
  );
}

function MetricCell({
  metric,
  overflow,
  sample,
  failed,
  animate,
}: {
  metric: HeaderMetric;
  overflow: boolean;
  sample: HeaderMetrics | null;
  failed: boolean;
  animate: boolean;
}) {
  const value = sample ? headerMetricValue(metric, sample) : failed ? "Unavailable" : "Reading";
  const compact = value === "Unavailable" ? "—" : value === "Reading" ? "…" : value;
  return (
    <span
      className="host-metric"
      role="group"
      aria-label={`${HEADER_METRIC_LABELS[metric]}: ${value}`}
      data-metric={metric}
      data-overflow={overflow || undefined}
      data-available={value !== "Unavailable" && value !== "Reading"}
      data-tauri-drag-region
    >
      <span className="host-metric-label" aria-hidden="true" data-tauri-drag-region>
        {HEADER_METRIC_LABELS[metric]}
      </span>
      <strong className="host-metric-reading" aria-hidden="true" data-tauri-drag-region>
        <span className="host-metric-value" aria-hidden="true" data-tauri-drag-region>
          <MetricValue
            metric={metric}
            sample={sample}
            animate={animate}
            compact
            fallback={compact}
          />
        </span>
      </strong>
    </span>
  );
}

function bone(width: string): CSSProperties {
  return { "--bone-width": width } as CSSProperties;
}

export function HostMetrics({
  target,
  name,
  metrics,
  seconds,
  onSettings,
}: {
  target: string;
  name: string;
  metrics: HeaderMetric[];
  seconds: number;
  onSettings: () => void;
}) {
  const reading = useHeaderMetrics(target, metrics, seconds);
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<MetricRangeSeconds>(DEFAULT_METRIC_RANGE);
  const { present, closing } = usePopoverExit(open);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const values = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(metrics.length);
  const metricOrder = metrics.join(",");
  const status = !reading.visible
    ? "Paused"
    : reading.error
      ? reading.sample
        ? "Stale"
        : "Unavailable"
      : reading.stale
        ? "Stale"
        : reading.sample
          ? "Live"
          : "Reading";
  const readingTime = reading.sample ? formatReadingTime(reading.sample.sampledAt) : null;
  const rangeLabel = METRIC_RANGES.find((option) => option.seconds === range)!.label;
  const end = reading.now;
  const visibleReadings = readingsInRange(reading.history, end, range);
  const gap = missingReadingGap(reading.interval);
  const covered = coveredSeconds(reading.history, end, range);
  const partial = reading.history.length > 0 && covered < range - reading.interval * 2;
  const charted = metrics.filter((metric) => metric !== "uptime");
  const animate = status === "Live";
  const waiting = status === "Reading";
  const StatusIcon = {
    Live: Circle,
    Reading: CircleDashed,
    Stale: Clock3,
    Paused: Pause,
    Unavailable: CircleAlert,
  }[status];
  const statusDescription = {
    Live: "Readings refresh automatically.",
    Reading: "Waiting for the first host reading.",
    Stale: "The last host reading is out of date. Open host details to refresh or check errors.",
    Paused: "Automatic refresh is paused while the window is hidden.",
    Unavailable: "Host metrics could not be read. Open host details to check errors and retry.",
  }[status];
  useLayoutEffect(() => {
    const element = values.current;
    if (!element) return;
    const cells = Array.from(element.children);
    const measure = () => {
      const right = element.getBoundingClientRect().right;
      const firstOverflow = cells.findIndex((cell) => cell.getBoundingClientRect().right > right);
      setVisibleCount(firstOverflow === -1 ? cells.length : firstOverflow);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    cells.forEach((cell) => observer?.observe(cell));
    return () => observer?.disconnect();
  }, [metricOrder, target]);
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div
      className="host-metrics"
      ref={container}
      data-state={status.toLowerCase()}
      data-sampling={reading.sampling || undefined}
      data-tauri-drag-region
    >
      <button
        type="button"
        className="host-metrics-trigger"
        ref={trigger}
        onClick={() => setOpen((value) => !value)}
        aria-label={`${status}: Host metrics for ${name}`}
        title={`Readings for ${name}. ${statusDescription}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        <span
          className="host-metrics-status"
          data-state={status.toLowerCase()}
          role="status"
          aria-label={statusDescription}
        >
          <StatusIcon size={12} aria-hidden="true" />
          {status}
        </span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <div
        className="host-metrics-values"
        data-empty={visibleCount === 0 || undefined}
        data-tauri-drag-region
        ref={values}
        role="group"
        aria-label="Current host readings"
        aria-hidden={visibleCount === 0 || undefined}
      >
        {metrics.map((metric, index) => (
          <MetricCell
            key={`${target}:${metric}`}
            metric={metric}
            overflow={index >= visibleCount}
            sample={reading.sample}
            failed={!!reading.error}
            animate={animate}
          />
        ))}
      </div>
      {present && (
        <section
          className="host-metrics-panel"
          id={panelId}
          aria-label={closing ? undefined : `Readings for ${name}`}
          aria-hidden={closing || undefined}
          inert={closing || undefined}
          data-closing={closing || undefined}
          data-state={status.toLowerCase()}
          data-app-popover=""
        >
          <header>
            <h3>{name}</h3>
            <button
              className="icon-button"
              type="button"
              aria-label="Refresh readings"
              title="Refresh readings"
              onClick={reading.refresh}
              disabled={reading.sampling || !reading.visible}
            >
              <RefreshCw size={14} />
            </button>
            <button
              ref={close}
              className="icon-button"
              type="button"
              aria-label="Close host metrics"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <X size={15} />
            </button>
          </header>
          <div className="host-metrics-summary">
            <p>
              <span className="host-metrics-status" data-state={status.toLowerCase()}>
                <StatusIcon size={12} aria-hidden="true" />
                {status}
              </span>
              <span>
                {readingTime === null
                  ? waiting
                    ? "Waiting for a reading"
                    : "No readings yet"
                  : readingTime === "Unavailable"
                    ? "Update time unknown"
                    : `Updated ${readingTime}`}
              </span>
              {partial && <span>{`${formatCoverage(covered)} of history`}</span>}
            </p>
            <fieldset className="host-metrics-range">
              <legend className="sr-only">History range</legend>
              {METRIC_RANGES.map((option) => (
                <label key={option.seconds} data-selected={option.seconds === range || undefined}>
                  <input
                    className="sr-only"
                    type="radio"
                    name={`${panelId}-range`}
                    value={option.seconds}
                    checked={option.seconds === range}
                    onChange={() => setRange(option.seconds)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
          </div>
          {reading.error && <p className="inline-error host-metrics-error">{reading.error}</p>}
          <dl aria-busy={waiting || undefined}>
            {charted.map((metric, index) => {
              const detail =
                metric === "diskIo" ? null : headerMetricDetail(metric, reading.sample);
              const unavailable =
                !waiting && headerMetricValue(metric, reading.sample) === "Unavailable";
              return (
                <div
                  key={`${target}:${metric}`}
                  className={waiting ? "skeleton-row" : undefined}
                  style={{ "--skeleton-row": index } as CSSProperties}
                  data-metric={metric}
                >
                  <dt>{HEADER_METRIC_LABELS[metric]}</dt>
                  <dd className="host-metric-figure">
                    {waiting ? (
                      <span className="skeleton-bone" data-shape="title" style={bone("56%")} />
                    ) : (
                      <strong data-unavailable={unavailable || undefined}>
                        {metric === "diskIo" ? (
                          <>
                            <AnimatedNumber
                              value={
                                unavailable || !reading.sample ? null : writeRate(reading.sample)
                              }
                              format={formatByteRate}
                              animate={animate}
                            />
                            {!unavailable && (
                              <span className="host-metric-direction" data-trace="main">
                                write
                              </span>
                            )}
                          </>
                        ) : (
                          <MetricValue metric={metric} sample={reading.sample} animate={animate} />
                        )}
                      </strong>
                    )}
                    <small>
                      {metric === "diskIo" && reading.sample && !unavailable ? (
                        <>
                          <span className="host-metric-direction" data-trace="read">
                            Read
                          </span>
                          <AnimatedNumber
                            value={readRate(reading.sample)}
                            format={formatByteRate}
                            animate={animate}
                          />
                        </>
                      ) : (
                        (detail ?? " ")
                      )}
                    </small>
                  </dd>
                  <dd className="host-metric-chart">
                    <MetricChart
                      metric={metric}
                      readings={visibleReadings}
                      end={end}
                      rangeSeconds={range}
                      rangeLabel={rangeLabel}
                      gap={gap}
                    />
                  </dd>
                </div>
              );
            })}
          </dl>
          <footer>
            {metrics.includes("uptime") && (
              <span className="host-metrics-uptime">
                {waiting ? (
                  <span className="skeleton-bone" data-shape="caption" style={bone("64px")} />
                ) : formatUptime(reading.sample?.uptimeSeconds) === "Unavailable" ? (
                  "Uptime unavailable"
                ) : (
                  `Up ${formatUptime(reading.sample?.uptimeSeconds)}`
                )}
              </span>
            )}
            <button className="secondary-button" type="button" onClick={onSettings}>
              Customize in Settings
            </button>
          </footer>
        </section>
      )}
    </div>
  );
}
