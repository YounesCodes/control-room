import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Circle, CircleAlert, CircleDashed, Clock3, ChevronDown, Pause, X } from "lucide-react";
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
  metricTrend,
} from "../lib/header-metrics";
import type { HeaderMetric, HeaderMetrics } from "../types";

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
          {compact ? "W" : "· Write"}
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

function MetricTrace({ metric, history }: { metric: HeaderMetric; history: HeaderMetrics[] }) {
  const path = metricTrend(metric, history);
  if (!path) return null;
  return (
    <svg className="host-metric-trend" viewBox="0 0 34 16" aria-hidden="true" focusable="false">
      <path d={path} style={{ d: `path("${path}")` }} />
    </svg>
  );
}

function MetricCell({
  metric,
  overflow,
  sample,
  history,
  failed,
  animate,
}: {
  metric: HeaderMetric;
  overflow: boolean;
  sample: HeaderMetrics | null;
  history: HeaderMetrics[];
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
      title={`${HEADER_METRIC_LABELS[metric]}: ${value}. ${headerMetricDetail(metric, sample)}`}
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
        <MetricTrace metric={metric} history={history} />
      </strong>
    </span>
  );
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
  const StatusIcon = {
    Live: Circle,
    Reading: CircleDashed,
    Stale: Clock3,
    Paused: Pause,
    Unavailable: CircleAlert,
  }[status];
  const statusDescription = {
    Live: "Automatic refresh is active. The latest host reading is current.",
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
      // Hidden cells keep their layout boxes so they can reappear as space returns.
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
            history={reading.history}
            failed={!!reading.error}
            animate={status === "Live"}
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
          data-app-popover=""
        >
          <header>
            <h3>{name}</h3>
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
          <p>
            {status}
            {reading.sample
              ? ` · Last reading time ${formatReadingTime(reading.sample.sampledAt)}`
              : " · Waiting for a reading"}
          </p>
          <dl>
            {metrics.map((metric) => (
              <div key={`${target}:${metric}`}>
                <dt>{HEADER_METRIC_LABELS[metric]}</dt>
                <dd>
                  <div className="host-metric-detail-value">
                    <strong>
                      <MetricValue
                        metric={metric}
                        sample={reading.sample}
                        animate={status === "Live"}
                      />
                    </strong>
                    <MetricTrace metric={metric} history={reading.history} />
                  </div>
                  <small>{headerMetricDetail(metric, reading.sample)}</small>
                </dd>
              </div>
            ))}
          </dl>
          {reading.error && <p className="host-metrics-error">{reading.error}</p>}
          <footer>
            <button
              className="secondary-button"
              type="button"
              onClick={reading.refresh}
              disabled={reading.sampling || !reading.visible}
            >
              Refresh
            </button>
            <button className="secondary-button" type="button" onClick={onSettings}>
              Customize in Settings
            </button>
          </footer>
        </section>
      )}
    </div>
  );
}
