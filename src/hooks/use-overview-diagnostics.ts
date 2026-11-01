import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { DiagnosticWorkloads, OverviewDiagnostics } from "../types";

export const OVERVIEW_HISTORY_LIMIT = 120;
export const OVERVIEW_HISTORY_MS = 5 * 60 * 1000;
interface Reading {
  target: string;
  sample: OverviewDiagnostics | null;
  history: OverviewDiagnostics[];
  workloads: DiagnosticWorkloads | null;
  error: string | null;
  sampling: boolean;
}

export function useOverviewDiagnostics(target: string, active: boolean, seconds: number) {
  const interval = [2, 5, 10, 30].includes(seconds) ? seconds : 5;
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  const [reading, setReading] = useState<Reading | null>(null);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(Date.now());
  const inFlight = useRef(false);
  const workloadTime = useRef(0);
  const enabled = active && visible;
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    workloadTime.current = 0;
  }, [target]);
  useEffect(() => {
    if (!enabled) {
      setReading((current) => (current ? { ...current, history: [], sampling: false } : null));
      return;
    }
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay = interval * 1000) => {
      if (current) timer = setTimeout(run, delay);
    };
    const run = async () => {
      if (!current) return;
      if (inFlight.current) {
        schedule();
        return;
      }
      inFlight.current = true;
      let nextDelay = interval * 1000;
      setReading((previous) => ({
        target,
        sample: previous?.target === target ? previous.sample : null,
        history: previous?.target === target ? previous.history : [],
        workloads: previous?.target === target ? previous.workloads : null,
        error: previous?.target === target ? previous.error : null,
        sampling: true,
      }));
      try {
        const includeWorkloads = Date.now() - workloadTime.current >= 30_000;
        const sample = await api.sampleOverviewDiagnostics(target, includeWorkloads);
        if (current) {
          if (sample.workloads) workloadTime.current = Date.now();
          setReading((previous) => {
            const lastTime = Date.parse(previous?.history.at(-1)?.sampledAt ?? "");
            const time = Date.parse(sample.sampledAt);
            const continuous =
              previous?.target === target &&
              !previous.error &&
              time > lastTime &&
              time - lastTime < (interval * 2 + 30) * 1000;
            const history = continuous ? previous.history : [];
            return {
              target,
              sample,
              sampling: false,
              error: null,
              workloads:
                sample.workloads ?? (previous?.target === target ? previous.workloads : null),
              history: Number.isFinite(time)
                ? [...history, sample]
                    .filter((point) => time - Date.parse(point.sampledAt) <= OVERVIEW_HISTORY_MS)
                    .slice(-OVERVIEW_HISTORY_LIMIT)
                : [],
            };
          });
        }
      } catch (error) {
        // The retiring header may still own its bounded SSH read. Wait for
        // its permit without reporting a normal view transition as failure.
        if (errorMessage(error).includes("Previous reading for this host is still finishing")) {
          nextDelay = 1000;
          if (current)
            setReading((previous) => (previous ? { ...previous, sampling: false } : null));
          return;
        }
        if (current)
          setReading((previous) => ({
            target,
            sample: previous?.target === target ? previous.sample : null,
            history: previous?.target === target ? previous.history : [],
            workloads: previous?.target === target ? previous.workloads : null,
            sampling: false,
            error: errorMessage(error),
          }));
      } finally {
        inFlight.current = false;
        schedule(nextDelay);
      }
    };
    void run();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [target, enabled, interval, retry]);
  const current = reading?.target === target ? reading : null;
  const sampledAt = Date.parse(current?.sample?.sampledAt ?? "");
  useEffect(() => {
    if (!Number.isFinite(sampledAt)) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, sampledAt + (interval + 30) * 1000 - Date.now() + 1),
    );
    return () => clearTimeout(timer);
  }, [sampledAt, interval]);
  const stale =
    !!current?.sample &&
    (!!current.error ||
      !enabled ||
      !Number.isFinite(sampledAt) ||
      Math.max(now, Date.now()) - sampledAt > (interval + 30) * 1000);
  return {
    sample: current?.sample ?? null,
    history: current?.history ?? [],
    workloads: current?.workloads ?? null,
    error: current?.error ?? null,
    sampling: current?.sampling ?? false,
    stale,
    enabled,
    refresh: () => {
      workloadTime.current = 0;
      setRetry((value) => value + 1);
    },
  };
}
