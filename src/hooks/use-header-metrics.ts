import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { HeaderMetric, HeaderMetrics } from "../types";

interface Reading {
  key: string;
  sample: HeaderMetrics | null;
  error: string | null;
  sampling: boolean;
}
export function useHeaderMetrics(target: string | null, metrics: HeaderMetric[], seconds: number) {
  const interval = [2, 5, 10, 30].includes(seconds) ? seconds : 5;
  const selection = metrics.join(",");
  const key = `${target}:${selection}:${interval}`;
  const [reading, setReading] = useState<Reading | null>(null);
  const inFlight = useRef(false);
  const [visible, setVisible] = useState(
    typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (typeof document === "undefined") return;
    const changed = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (target === null || !selection || !visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      if (active) timer = setTimeout(run, interval * 1000);
    };
    const run = async () => {
      if (!active) return;
      if (inFlight.current) {
        schedule();
        return;
      }
      inFlight.current = true;
      setReading((current) => ({
        key,
        sample: current?.key === key ? current.sample : null,
        error: current?.key === key ? current.error : null,
        sampling: true,
      }));
      try {
        const sample = await api.sampleHeaderMetrics(
          target === "local" ? null : target,
          selection.split(",") as HeaderMetric[],
        );
        if (active) setReading({ key, sample, error: null, sampling: false });
      } catch (error) {
        if (active)
          setReading((current) => ({
            key,
            sample: current?.key === key ? current.sample : null,
            error: errorMessage(error),
            sampling: false,
          }));
      } finally {
        inFlight.current = false;
        schedule();
      }
    };
    void run();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [target, selection, interval, key, visible, retry]);
  const current = reading?.key === key ? reading : null;
  const sample = current?.sample ?? null;
  const sampledAt = sample ? Date.parse(sample.sampledAt) : NaN;
  useEffect(() => {
    if (!Number.isFinite(sampledAt)) return;
    const deadline = sampledAt + (interval + 2) * 1000;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [sampledAt, interval]);
  const stale =
    !!sample &&
    (!visible ||
      !!current?.error ||
      !Number.isFinite(sampledAt) ||
      Math.max(now, Date.now()) - sampledAt > (interval + 2) * 1000);
  return {
    sample,
    error: current?.error ?? null,
    sampling: current?.sampling ?? false,
    stale,
    visible,
    refresh: () => setRetry((current) => current + 1),
  };
}
