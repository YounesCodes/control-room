import { useId, useRef, useState, type CSSProperties } from "react";

/// Index of `value` in `options`, or of the nearest option when a saved value
/// is not one of them, so the thumb always rests on a stop.
export function stepIndex(options: number[], value: number): number {
  const exact = options.indexOf(value);
  if (exact !== -1) return exact;
  let nearest = 0;
  options.forEach((option, index) => {
    if (Math.abs(option - value) < Math.abs(options[nearest] - value)) nearest = index;
  });
  return nearest;
}

/// A slider over a few fixed choices. The native range input keeps keyboard,
/// pointer, and screen-reader behaviour; the track, stops, and labels are drawn
/// around it. A value bubble follows the thumb while it is hovered, focused, or
/// dragged.
export function StepSlider({
  label,
  options,
  value,
  format,
  tick = String,
  onChange,
  className,
}: {
  label: string;
  options: number[];
  value: number;
  /** Full value text for the bubble and screen readers, such as "Every 5 seconds". */
  format: (value: number) => string;
  /** Short label under each stop, such as "5s". */
  tick?: (value: number) => string;
  onChange: (value: number) => void;
  className?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const index = stepIndex(options, value);
  const last = Math.max(1, options.length - 1);
  const position = (step: number) => ({ "--step": step / last }) as CSSProperties;
  const choose = (step: number) => {
    // A disabled fieldset disables the input without setting its attribute.
    if (input.current?.matches(":disabled")) return;
    onChange(options[step]);
    input.current?.focus();
  };
  return (
    <div
      className={["step-slider", className].filter(Boolean).join(" ")}
      style={position(index)}
      data-dragging={dragging || undefined}
    >
      <label className="step-slider-label" htmlFor={id}>
        {label}
      </label>
      <div className="step-slider-control">
        <div className="step-slider-track" aria-hidden="true">
          <span className="step-slider-fill" />
          {options.map((option, step) => (
            <span
              className="step-slider-stop"
              data-reached={step <= index || undefined}
              style={position(step)}
              key={option}
            />
          ))}
        </div>
        <input
          ref={input}
          id={id}
          type="range"
          min={0}
          max={options.length - 1}
          step={1}
          value={index}
          aria-valuetext={format(options[index])}
          onChange={(event) => onChange(options[Number(event.target.value)])}
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onBlur={() => setDragging(false)}
        />
        <output className="step-slider-bubble" htmlFor={id} aria-hidden="true">
          {format(options[index])}
        </output>
        <div className="step-slider-ticks" aria-hidden="true">
          {options.map((option, step) => (
            <span
              key={option}
              style={position(step)}
              data-selected={step === index || undefined}
              onClick={() => choose(step)}
            >
              {tick(option)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
