import { useEffect, useRef, useState } from "react";

import { api, errorMessage } from "./api";
import type { HostResources } from "../types";

/**
 * Samples host load while the Overview pane is open.
 *
 * This is the one place in Control Room that repeats a read on a timer, and it
 * is deliberately scoped so it stays an on-demand read rather than monitoring:
 *
 * - it runs only while the pane is mounted and `live` is on, and the interval
 *   is torn down on unmount or when the user pauses it
 * - it skips a tick while the window is hidden, so a backgrounded app stops
 *   talking to the host entirely
 * - it never overlaps requests, so a slow host slows the cadence instead of
 *   queueing round trips behind each other
 * - samples live in this hook's state and nowhere else. Nothing is written to
 *   SQLite, so closing the pane forgets the window and there is no history to
 *   read back later
 */
export const SAMPLE_INTERVAL_MS = 4000;
export const SAMPLE_WINDOW = 45;

export interface HostResourceState {
  /** Oldest first, capped at SAMPLE_WINDOW. */
  samples: HostResources[];
  latest: HostResources | null;
  /** The last failure. Kept alongside the samples rather than replacing them. */
  error: string | null;
  /** True while a round trip is in flight. */
  sampling: boolean;
}

const EMPTY: HostResourceState = { samples: [], latest: null, error: null, sampling: false };

export function useHostResources(connectionId: string, live: boolean): HostResourceState {
  const [state, setState] = useState<HostResourceState>(EMPTY);
  // Held in a ref so a slow reply cannot start a second request behind itself.
  const inFlight = useRef(false);

  useEffect(() => {
    setState(EMPTY);
  }, [connectionId]);

  useEffect(() => {
    if (!live) {
      setState((current) => ({ ...current, sampling: false }));
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (!active) return;
      timer = setTimeout(run, SAMPLE_INTERVAL_MS);
    };

    const run = async () => {
      if (!active) return;
      // A hidden window has nobody reading the meters, so nothing is asked of
      // the host until it comes back.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        schedule();
        return;
      }
      if (inFlight.current) {
        schedule();
        return;
      }
      inFlight.current = true;
      setState((current) => ({ ...current, sampling: true }));
      try {
        const sample = await api.sampleHostResources(connectionId);
        if (!active) return;
        setState((current) => ({
          samples: [...current.samples, sample].slice(-SAMPLE_WINDOW),
          latest: sample,
          error: null,
          sampling: false,
        }));
      } catch (caught) {
        if (!active) return;
        // The window it already drew stays on screen; a failed tick is not a
        // reason to blank a chart that was correct a moment ago.
        setState((current) => ({ ...current, error: errorMessage(caught), sampling: false }));
      } finally {
        inFlight.current = false;
        schedule();
      }
    };

    void run();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [connectionId, live]);

  return state;
}
