import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  idleUpdateState,
  shouldRunAutomaticCheck,
  type AppUpdateState,
} from "../lib/app-update";
import type { AppUpdateInfo, PendingUpdateNotice, UpdateFailure, UpdateProgress } from "../types";

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

  /** A check that reports nothing on failure. Used by the scheduler. */
  const runCheck = useCallback(async (): Promise<AppUpdateInfo | null | "failed"> => {
    setState({ status: "checking" });
    try {
      const info = await api.checkForUpdate();
      lastCheckedAt.current = Date.now();
      setState(info ? { status: "available", info } : idleUpdateState);
      return info;
    } catch {
      // Deliberately swallowed. An automatic check that fails says nothing: the
      // reason is only actionable for a manual check, which reports its own.
      // It is eligible again at the next interval, so this never becomes a
      // permanent failed state and never retries in a tight loop.
      lastCheckedAt.current = Date.now();
      setState(idleUpdateState);
      return "failed";
    }
  }, []);

  /** The manual Settings check, which does report its outcome. */
  const checkNow = useCallback(async (): Promise<ManualCheckResult> => {
    if (stateRef.current.status === "checking") {
      return {
        outcome: "failed",
        failure: { kind: "check", message: "A check is already running." },
      };
    }
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

  // One timer for the life of the application. The first check waits so it
  // never competes with connection loading and workspace restore, and later
  // checks are twelve hours apart.
  useEffect(() => {
    let cancelled = false;

    const maybeCheck = () => {
      if (cancelled) return;
      const runnable = shouldRunAutomaticCheck({
        enabled: automaticRef.current,
        state: stateRef.current,
        lastCheckedAt: lastCheckedAt.current,
        now: Date.now(),
        intervalMs: CHECK_INTERVAL_MS,
      });
      if (runnable) void runCheck();
    };

    const first = window.setTimeout(maybeCheck, FIRST_CHECK_DELAY_MS);
    // Ticking hourly and deciding in `shouldRunAutomaticCheck` keeps the twelve
    // hour spacing honest across a machine that slept, without the timer itself
    // needing to know anything about time drift.
    const repeat = window.setInterval(maybeCheck, 60 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(repeat);
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
