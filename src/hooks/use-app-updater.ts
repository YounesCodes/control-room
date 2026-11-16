import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import {
  FIRST_CHECK_DELAY_MS,
  FOREGROUND_REFRESH_AFTER_MS,
  PERIODIC_CHECK_INTERVAL_MS,
  SCHEDULER_TICK_INTERVAL_MS,
  idleUpdateState,
  shouldRunAutomaticCheck,
  shouldRunForegroundRefresh,
  type AppUpdateState,
} from "../lib/app-update";
import type { PendingUpdateNotice, UpdateFailure, UpdateProgress } from "../types";

export type ManualCheckResult =
  | { outcome: "current" }
  | { outcome: "available"; version: string }
  | { outcome: "failed"; failure: UpdateFailure };

function asFailure(error: unknown, fallbackKind: UpdateFailure["kind"]): UpdateFailure {
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    "message" in error &&
    typeof (error as UpdateFailure).message === "string"
  ) {
    return error as UpdateFailure;
  }
  return {
    kind: fallbackKind,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function useAppUpdater(automaticChecks: boolean) {
  const [state, setRenderedState] = useState<AppUpdateState>(idleUpdateState);
  const [notice, setNotice] = useState<PendingUpdateNotice | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  const stateRef = useRef(state);
  const setState = useCallback(
    (next: AppUpdateState | ((previous: AppUpdateState) => AppUpdateState)) => {
      const value = typeof next === "function" ? next(stateRef.current) : next;
      stateRef.current = value;
      setRenderedState(value);
    },
    [],
  );
  const lastCheckedAt = useRef<number | null>(null);
  const automaticRef = useRef(automaticChecks);
  automaticRef.current = automaticChecks;
  const checkInFlight = useRef(false);

  const runCheck = useCallback(
    async (eligible: boolean) => {
      if (
        !eligible ||
        checkInFlight.current ||
        stateRef.current.status === "downloading" ||
        stateRef.current.status === "installing"
      )
        return;
      checkInFlight.current = true;
      setState({ status: "checking" });
      try {
        const info = await api.checkForUpdate();
        lastCheckedAt.current = Date.now();
        setState(info ? { status: "available", info } : idleUpdateState);
      } catch {
        lastCheckedAt.current = Date.now();
        setState(idleUpdateState);
      } finally {
        checkInFlight.current = false;
      }
    },
    [setState],
  );

  const checkNow = useCallback(async (): Promise<ManualCheckResult> => {
    if (
      checkInFlight.current ||
      stateRef.current.status === "downloading" ||
      stateRef.current.status === "installing"
    ) {
      return {
        outcome: "failed",
        failure: { kind: "check", message: "Another update operation is already running." },
      };
    }
    checkInFlight.current = true;
    setState({ status: "checking" });
    try {
      const info = await api.checkForUpdate();
      lastCheckedAt.current = Date.now();
      setState(info ? { status: "available", info } : idleUpdateState);
      return info ? { outcome: "available", version: info.version } : { outcome: "current" };
    } catch (error) {
      lastCheckedAt.current = Date.now();
      setState(idleUpdateState);
      return { outcome: "failed", failure: asFailure(error, "check") };
    } finally {
      checkInFlight.current = false;
    }
  }, [setState]);

  const download = useCallback(async () => {
    const current = stateRef.current;
    const info = "info" in current ? current.info : null;
    if (!info || (current.status !== "available" && current.status !== "failed")) return;

    setState({ status: "downloading", info, downloaded: 0, total: null });
    const progress = new Channel<UpdateProgress>();
    progress.onmessage = (message) => {
      setState((previous) => {
        if (previous.status !== "downloading") return previous;
        switch (message.event) {
          case "started":
            return { ...previous, downloaded: 0, total: message.contentLength };
          case "progress":
            return { ...previous, downloaded: message.downloaded, total: message.total };
          case "finished":
            return previous;
        }
      });
    };

    try {
      await api.downloadUpdate(progress);
      setState({ status: "downloaded", info });
    } catch (error) {
      setState({ status: "failed", info, failure: asFailure(error, "download") });
    }
  }, [setState]);

  const install = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== "downloaded") return;
    setState({ status: "installing", info: current.info });
    try {
      await api.installUpdate();
    } catch (error) {
      setState({
        status: "failed",
        info: current.info,
        failure: asFailure(error, "install"),
      });
    }
  }, [setState]);

  const dismissNotice = useCallback(() => {
    setNotice(null);
    void api.dismissUpdateNotice().catch(() => {});
  }, []);

  const dismissFailure = useCallback(() => {
    setState((previous) =>
      previous.status === "failed" ? { status: "available", info: previous.info } : previous,
    );
  }, [setState]);

  useEffect(() => {
    let cancelled = false;
    void api
      .currentAppVersion()
      .then((version) => {
        if (!cancelled) setCurrentVersion(version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api
      .pendingUpdateNotice()
      .then((pending) => {
        if (!cancelled) setNotice(pending);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const maybeCheck = () => {
      if (cancelled) return;
      void runCheck(
        shouldRunAutomaticCheck({
          enabled: automaticRef.current,
          state: stateRef.current,
          lastCheckedAt: lastCheckedAt.current,
          now: Date.now(),
          intervalMs: PERIODIC_CHECK_INTERVAL_MS,
        }),
      );
    };

    const maybeRefreshOnForeground = () => {
      if (cancelled) return;
      void runCheck(
        shouldRunForegroundRefresh({
          enabled: automaticRef.current,
          state: stateRef.current,
          lastCheckedAt: lastCheckedAt.current,
          now: Date.now(),
          thresholdMs: FOREGROUND_REFRESH_AFTER_MS,
        }),
      );
    };

    const first = window.setTimeout(maybeCheck, FIRST_CHECK_DELAY_MS);
    const tick = window.setInterval(maybeCheck, SCHEDULER_TICK_INTERVAL_MS);
    window.addEventListener("focus", maybeRefreshOnForeground);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") maybeRefreshOnForeground();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(tick);
      window.removeEventListener("focus", maybeRefreshOnForeground);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [runCheck]);

  return {
    state,
    notice,
    currentVersion,
    checkNow,
    download,
    install,
    dismissNotice,
    dismissFailure,
  };
}
