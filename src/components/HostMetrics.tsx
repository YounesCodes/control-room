import { useEffect, useId, useRef, useState } from "react";
import { Gauge, X } from "lucide-react";
import { useHeaderMetrics } from "../hooks/use-header-metrics";
import {
  HEADER_METRIC_LABELS,
  formatReadingTime,
  headerMetricDetail,
  headerMetricValue,
} from "../lib/header-metrics";
import type { HeaderMetric } from "../types";

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
    <div className="host-metrics" ref={container}>
      <button
        type="button"
        className="host-metrics-target"
        ref={trigger}
        onClick={() => setOpen((value) => !value)}
        aria-label={`Host metrics for ${name}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        <Gauge size={14} aria-hidden="true" />
        <span>{name}</span>
      </button>
      <div
        className="host-metrics-values"
        ref={values}
        tabIndex={overflow ? 0 : undefined}
        role="group"
        aria-label={
          overflow ? "Current host readings. Scroll for more metrics." : "Current host readings"
        }
      >
        {metrics.map((metric) => (
          <span className="host-metric" key={metric}>
            <span>{HEADER_METRIC_LABELS[metric]}</span>
            <strong>
              {reading.sample
                ? headerMetricValue(metric, reading.sample)
                : reading.error
                  ? "Unavailable"
                  : "..."}
            </strong>
          </span>
        ))}
      </div>
      <span className="host-metrics-status" data-stale={status !== "Live"}>
        {status}
      </span>
      {open && (
        <section className="host-metrics-panel" id={panelId} aria-label={`Readings for ${name}`}>
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
                  <strong>{headerMetricValue(metric, reading.sample)}</strong>
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
