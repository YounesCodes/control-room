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

/** What a manual check from Settings reports back, separately from the
 *  application-wide state. A failed manual check is worth a sentence in
 *  Settings and is never worth a titlebar indicator. */
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

/**
 * The one update lifecycle for the whole application.
 *
 * Deliberately a single hook mounted once in `App`, not something a pane or a
 * Workspace can start. Update checking is not per-connection work and must not
 * multiply with Workspaces, so there is exactly one timer and one in-flight
 * check no matter how much of the app is open.
 *
 * Everything here is best effort. An automatic check that fails leaves the
 * state idle and says nothing: Control Room is a tool for reaching Linux hosts,
 * and its own update feed being unreachable is not the user's problem.
 */
export function useAppUpdater(automaticChecks: boolean) {
  const [state, setState] = useState<AppUpdateState>(idleUpdateState);
  const [notice, setNotice] = useState<PendingUpdateNotice | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  // Refs rather than state: the scheduler reads these without wanting a
  // re-render, and the timer must not restart every time progress ticks.
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastCheckedAt = useRef<number | null>(null);
  const automaticRef = useRef(automaticChecks);
  automaticRef.current = automaticChecks;
  // Set synchronously around every network check, automatic and manual alike.
  // Eligibility reads state that React updates asynchronously, so two triggers
  // — a timer tick and a focus event arriving together — could both see an
  // idle state and both pass a pure eligibility check; this ref is what keeps
  // "one in-flight check" literally true.
  const checkInFlight = useRef(false);

  /**
   * Runs one automatic check if `eligible`, and never two at once.
   *
   * Everything here is best effort: a check that fails leaves the state idle
   * and says nothing, and stays eligible for the next scheduled pass, so a
   * bad moment never becomes a permanent failed state or a tight retry loop.
   */
  const runCheck = useCallback(async (eligible: boolean) => {
    if (!eligible || checkInFlight.current) return;
    checkInFlight.current = true;
    setState({ status: "checking" });
    try {
      const info = await api.checkForUpdate();
      lastCheckedAt.current = Date.now();
      setState(info ? { status: "available", info } : idleUpdateState);
    } catch {
      // Deliberately swallowed. An automatic check that fails says nothing: the
      // reason is only actionable for a manual check, which reports its own.
      lastCheckedAt.current = Date.now();
      setState(idleUpdateState);
    } finally {
      checkInFlight.current = false;
    }
  }, []);

  /** The manual Settings check, which does report its outcome. */
  const checkNow = useCallback(async (): Promise<ManualCheckResult> => {
    if (checkInFlight.current) {
      return {
        outcome: "failed",
        failure: { kind: "check", message: "A check is already running." },
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
  }, []);

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
  }, []);

  /**
   * Installs and does not return on Windows: the NSIS installer replaces this
   * process. Anything that must survive has already been persisted by Rust
   * before the installer starts.
   */
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
  }, []);

  const dismissNotice = useCallback(() => {
    setNotice(null);
    void api.dismissUpdateNotice().catch(() => {});
  }, []);

  /** Clears a failure without losing the update it failed on. */
  const dismissFailure = useCallback(() => {
    setState((previous) =>
      previous.status === "failed" ? { status: "available", info: previous.info } : previous,
    );
  }, []);

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

  // The one-time "What's new". Rust only returns a notice whose version matches
  // the version now running, so a cancelled update never produces one.
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

  // One scheduler for the life of the application. The first check waits so it
  // never competes with connection loading and workspace restore. After that a
  // five minute tick re-evaluates a roughly hourly schedule, and returning to
  // the foreground refreshes a stale feed, so a release published while
  // Control Room sits open is found without restarting the app. Every decision
  // is a pure function in app-update.ts; this effect only wires events to them.
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
    // Ticking well under the hourly spacing keeps the spacing honest across a
    // machine that slept, without the timer itself needing to know anything
    // about time drift.
    const tick = window.setInterval(maybeCheck, SCHEDULER_TICK_INTERVAL_MS);
    // Minimize/restore and Alt-Tab back can each fire both events; the
    // in-flight guard in `runCheck` collapses them into at most one request.
    window.addEventListener("focus", maybeRefreshOnForeground);
    document.addEventListener("visibilitychange", maybeRefreshOnForeground);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(tick);
      window.removeEventListener("focus", maybeRefreshOnForeground);
      document.removeEventListener("visibilitychange", maybeRefreshOnForeground);
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
