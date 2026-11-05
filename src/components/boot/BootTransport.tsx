import { Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { BOOT_REPLAY_SPEEDS, formatOffsetClock, formatTPlus } from "../../lib/boot-replay";
import type { BootReplayClock } from "../../hooks/use-boot-replay-clock";

/**
 * The transport bar under the hero timeline: restart, play/pause, previous
 * and next notable events, a keyboard-operable scrub, an honest clock that
 * names the window (not the boot), and a speed control that never moves the
 * position.
 */
export function BootTransport({
  clock,
  windowUs,
  disabled,
  onPrevious,
  onNext,
}: {
  clock: BootReplayClock;
  windowUs: number;
  disabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const step = Math.max(1, Math.round(windowUs / 1000));
  return (
    <div className="boot-transport">
      <div className="boot-transport-controls" role="group" aria-label="Replay transport">
        <button
          type="button"
          className="secondary-button"
          disabled={disabled}
          onClick={clock.restart}
          aria-label="Restart replay from the beginning"
          title="Restart from the beginning"
        >
          <RotateCcw size={15} />
        </button>
        <button
          type="button"
          className="boot-transport-play"
          disabled={disabled}
          onClick={clock.toggle}
          aria-label={clock.playing ? "Pause replay" : "Play replay"}
          title={clock.playing ? "Pause" : "Play"}
        >
          {clock.playing ? <Pause size={15} /> : <Play size={15} />}
          {clock.playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled}
          onClick={onPrevious}
          aria-label="Previous notable event"
          title="Previous notable event"
        >
          <SkipBack size={15} />
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled}
          onClick={onNext}
          aria-label="Next notable event"
          title="Next notable event"
        >
          <SkipForward size={15} />
        </button>
      </div>
      <input
        type="range"
        className="boot-transport-seek"
        aria-label="Replay position in this window"
        min={0}
        max={Math.max(1, windowUs)}
        step={step}
        value={Math.min(clock.positionUs, windowUs)}
        disabled={disabled}
        onChange={(event) => clock.seek(Number(event.target.value))}
        aria-valuetext={`${formatTPlus(clock.positionUs)} of ${formatOffsetClock(windowUs)} window`}
      />
      <span className="boot-transport-time">
        <strong>T+{formatOffsetClock(clock.positionUs)}</strong>
        <span> / {formatOffsetClock(windowUs)} window</span>
      </span>
      <label className="boot-transport-speed">
        <span>Speed</span>
        <select
          aria-label="Replay speed"
          value={clock.speed}
          onChange={(event) => clock.setSpeed(Number(event.target.value))}
          disabled={disabled}
        >
          {BOOT_REPLAY_SPEEDS.map((speed) => (
            <option key={speed} value={speed}>
              {speed}×
            </option>
          ))}
        </select>
      </label>
      {clock.complete && (
        <p className="boot-transport-complete" role="status">
          Replay complete — this window has played through.
        </p>
      )}
    </div>
  );
}
