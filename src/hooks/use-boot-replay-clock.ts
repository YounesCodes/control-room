import { useCallback, useEffect, useRef, useState } from "react";
import { BOOT_REPLAY_SPEEDS } from "../lib/boot-replay";

/** How often the throttled position state catches up to the live clock. The
 * playhead marker itself is written on every frame through a DOM ref; React
 * state only drives labels and counts, so nothing re-renders per frame. */
const POSITION_STATE_INTERVAL_MS = 100;
/** Without requestAnimationFrame (and in jsdom) a short interval keeps the
 * same wall-clock-driven math without drifting. */
const FALLBACK_TICK_MS = 30;

export interface BootReplayClock {
  /** Throttled playback position for labels and derived state. */
  positionUs: number;
  playing: boolean;
  speed: number;
  /** The playhead has reached the window end and stopped. */
  complete: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  restart: () => void;
  seek: (positionUs: number) => void;
  setSpeed: (speed: number) => void;
  /** Live position without waiting for the throttled state. */
  position: () => number;
}

/**
 * A deterministic, client-side replay clock. The virtual position advances
 * from measured wall-clock deltas multiplied by the speed, so playback never
 * drifts with frame timing, pausing is exact, seeking is synchronous, and a
 * speed change keeps the position it found. Nothing here touches the network:
 * once a bounded page is loaded, playback is purely local. `onTick` fires on
 * every frame with the live position so the caller can move the playhead
 * without waiting for the throttled state.
 */
export function useBootReplayClock({
  durationUs,
  onTick,
  initialSpeed = 1,
}: {
  durationUs: number;
  onTick?: (positionUs: number) => void;
  initialSpeed?: number;
}): BootReplayClock {
  const positionRef = useRef(0);
  const lastWallMsRef = useRef(0);
  const stateSyncMsRef = useRef(0);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;
  const [positionUs, setPositionUs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState(
    BOOT_REPLAY_SPEEDS.some((option) => option === initialSpeed) ? initialSpeed : 1,
  );
  const [complete, setComplete] = useState(false);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const clamp = useCallback(
    (value: number) => Math.min(durationUs, Math.max(0, value)),
    [durationUs],
  );

  const syncPositionState = useCallback((force: boolean) => {
    const now = performance.now();
    if (!force && now - stateSyncMsRef.current < POSITION_STATE_INTERVAL_MS) return;
    stateSyncMsRef.current = now;
    setPositionUs(positionRef.current);
  }, []);

  useEffect(() => {
    if (!playing || durationUs <= 0) {
      lastWallMsRef.current = 0;
      return;
    }
    lastWallMsRef.current = performance.now();
    stateSyncMsRef.current = performance.now();

    const advance = () => {
      const now = performance.now();
      const elapsedMs = now - lastWallMsRef.current;
      lastWallMsRef.current = now;
      const next = positionRef.current + elapsedMs * 1000 * speedRef.current;
      if (next >= durationUs) {
        positionRef.current = durationUs;
        setPlaying(false);
        setComplete(true);
        setPositionUs(durationUs);
        onTickRef.current?.(durationUs);
        return;
      }
      positionRef.current = next;
      onTickRef.current?.(next);
      syncPositionState(false);
    };

    let stopped = false;
    let frame = 0;
    if (typeof requestAnimationFrame === "function") {
      const step = () => {
        if (stopped) return;
        advance();
        if (!stopped && positionRef.current < durationUs) {
          frame = requestAnimationFrame(step);
        }
      };
      frame = requestAnimationFrame(step);
      return () => {
        stopped = true;
        cancelAnimationFrame(frame);
      };
    }
    const timer = setInterval(advance, FALLBACK_TICK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [playing, speed, durationUs, syncPositionState]);

  // A smaller window keeps the position when it still fits and clamps when
  // it does not; a larger window simply extends the axis.
  useEffect(() => {
    if (positionRef.current > durationUs) {
      positionRef.current = durationUs;
      setPositionUs(durationUs);
    }
    setComplete(durationUs > 0 && positionRef.current >= durationUs);
    if (positionRef.current >= durationUs) setPlaying(false);
    onTickRef.current?.(positionRef.current);
  }, [durationUs]);

  // Hidden windows cannot be watched, so playback suspends instead of
  // silently running on. Playback resumes only on the user's next Play.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const suspend = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", suspend);
    return () => document.removeEventListener("visibilitychange", suspend);
  }, []);

  const play = useCallback(() => {
    if (durationUs <= 0) return;
    if (positionRef.current >= durationUs) {
      positionRef.current = 0;
      setPositionUs(0);
    }
    setComplete(false);
    setPlaying(true);
  }, [durationUs]);

  const pause = useCallback(() => {
    setPlaying(false);
    syncPositionState(true);
  }, [syncPositionState]);

  const seek = useCallback(
    (nextUs: number) => {
      positionRef.current = clamp(nextUs);
      if (positionRef.current < durationUs) setComplete(false);
      else if (positionRef.current === durationUs) setComplete(true);
      setPositionUs(positionRef.current);
      if (playing) lastWallMsRef.current = performance.now();
    },
    [clamp, durationUs, playing],
  );

  const restart = useCallback(() => {
    positionRef.current = 0;
    setComplete(false);
    setPositionUs(0);
    if (playing) lastWallMsRef.current = performance.now();
  }, [playing]);

  const setSpeed = useCallback((next: number) => {
    if (!BOOT_REPLAY_SPEEDS.some((option) => option === next)) return;
    if (next === speedRef.current) return;
    speedRef.current = next;
    setSpeedState(next);
  }, []);

  const toggle = useCallback(() => {
    if (playing) pause();
    else play();
  }, [pause, play, playing]);

  const position = useCallback(() => positionRef.current, []);

  return {
    positionUs,
    playing,
    speed,
    complete,
    play,
    pause,
    toggle,
    restart,
    seek,
    setSpeed,
    position,
  };
}
