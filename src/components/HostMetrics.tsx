import { useEffect, useId, useRef, useState } from "react";
import { Circle, CircleAlert, CircleDashed, Clock3, ChevronDown, Pause, X } from "lucide-react";
import { useHeaderMetrics } from "../hooks/use-header-metrics";
import { usePopoverExit } from "../hooks/use-popover-exit";
import {
  HEADER_METRIC_LABELS,
  formatReadingTime,
  headerMetricDetail,
  headerMetricValue,
  headerMetricNumber,
  formatByteRate,
  metricTrend,
} from "../lib/header-metrics";
import type { HeaderMetric, HeaderMetrics } from "../types";

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
  sample,
  history,
  failed,
}: {
  metric: HeaderMetric;
  sample: HeaderMetrics | null;
  history: HeaderMetrics[];
  failed: boolean;
}) {
  const value = sample ? headerMetricValue(metric, sample) : failed ? "Unavailable" : "Reading";
  const available = sample && headerMetricNumber(metric, sample) !== null;
  const compact = value === "Unavailable" ? "—" : value === "Reading" ? "…" : value;
  return (
    <span
      className="host-metric"
      role="group"
      aria-label={`${HEADER_METRIC_LABELS[metric]}: ${value}`}
      data-metric={metric}
      data-available={value !== "Unavailable" && value !== "Reading"}
      data-tauri-drag-region
      title={`${HEADER_METRIC_LABELS[metric]}: ${value}. ${headerMetricDetail(metric, sample)}`}
    >
      <span className="host-metric-label" aria-hidden="true" data-tauri-drag-region>
        {HEADER_METRIC_LABELS[metric]}
      </span>
      <strong className="host-metric-reading" aria-hidden="true" data-tauri-drag-region>
        <span className="host-metric-value" key={value} aria-hidden="true" data-tauri-drag-region>
          {metric === "diskIo" && available ? (
            <>
              <span className="host-metric-direction" data-tauri-drag-region>
                R
              </span>{" "}
              {formatByteRate(sample!.diskReadBytesPerSecond)}{" "}
              <span className="host-metric-direction" data-tauri-drag-region>
                W
              </span>{" "}
              {formatByteRate(sample!.diskWriteBytesPerSecond)}
            </>
          ) : (
            compact
          )}
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
  const [overflow, setOverflow] = useState(false);
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
  useEffect(() => {
    const element = values.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollWidth > element.clientWidth);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [metrics, reading.sample, reading.error, status]);
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
        onKeyDown={(event) => {
          if (!overflow) return;
          const row = event.currentTarget;
          const next =
            event.key === "ArrowLeft"
              ? row.scrollLeft - 80
              : event.key === "ArrowRight"
                ? row.scrollLeft + 80
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? row.scrollWidth
                    : null;
          if (next !== null) {
            event.preventDefault();
            row.scrollLeft = next;
          }
        }}
        data-tauri-drag-region
        ref={values}
        tabIndex={overflow ? 0 : undefined}
        role="group"
        aria-label={
          overflow ? "Current host readings. Scroll for more metrics." : "Current host readings"
        }
      >
        {metrics.map((metric) => (
          <MetricCell
            key={metric}
            metric={metric}
            sample={reading.sample}
            history={reading.history}
            failed={!!reading.error}
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
              <div key={metric}>
                <dt>{HEADER_METRIC_LABELS[metric]}</dt>
                <dd>
                  <div className="host-metric-detail-value">
                    <strong>{headerMetricValue(metric, reading.sample)}</strong>
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
