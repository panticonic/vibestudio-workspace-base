/**
 * Tangle — a number that lives inside a sentence and can be dragged.
 *
 * Drag horizontally (or use ←/→, Home/End) to change the value. The surrounding
 * prose and figures recompute immediately, so the reader explores the claim
 * instead of taking it on faith.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export interface TangleProps {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Pixels of horizontal drag per step. */
  pixelsPerStep?: number;
  format?: (value: number) => string;
  label: string;
}

export function clampToStep(value: number, min: number, max: number, step: number): number {
  const stepped = Math.round((value - min) / step) * step + min;
  const decimals = step.toString().split(".")[1]?.length ?? 0;
  return Number(Math.min(max, Math.max(min, stepped)).toFixed(decimals));
}

export function Tangle({
  value,
  onChange,
  min,
  max,
  step = 1,
  pixelsPerStep = 8,
  format,
  label,
}: TangleProps) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef<{ x: number; value: number } | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      origin.current = { x: event.clientX, value };
      setDragging(true);
      event.preventDefault();
    },
    [value]
  );
  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      if (!origin.current) return;
      const delta = Math.round((event.clientX - origin.current.x) / pixelsPerStep) * step;
      onChangeRef.current(clampToStep(origin.current.value + delta, min, max, step));
    },
    [max, min, pixelsPerStep, step]
  );
  const endDrag = useCallback(() => {
    origin.current = null;
    setDragging(false);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>) => {
      const big = step * 10;
      const next: Record<string, number | undefined> = {
        ArrowRight: value + step,
        ArrowUp: value + step,
        ArrowLeft: value - step,
        ArrowDown: value - step,
        PageUp: value + big,
        PageDown: value - big,
        Home: min,
        End: max,
      };
      const candidate = next[event.key];
      if (candidate === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      onChangeRef.current(clampToStep(candidate, min, max, step));
    },
    [max, min, step, value]
  );

  useEffect(() => {
    if (!dragging) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "ew-resize";
    return () => {
      document.body.style.cursor = previous;
    };
  }, [dragging]);

  return (
    <span
      className={`tangle${dragging ? " tangle--dragging" : ""}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={format ? format(value) : String(value)}
      title="Drag left or right to change"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      {format ? format(value) : value}
    </span>
  );
}

export interface PickProps<T extends string> {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  label: string;
}

/** Pick — a word inside a sentence that cycles through alternatives on click. */
export function Pick<T extends string>({ value, options, onChange, label }: PickProps<T>) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  );
  const current = options[index] ?? options[0];
  const advance = (direction: 1 | -1) => {
    const next = options[(index + direction + options.length) % options.length];
    if (next) onChange(next.value);
  };
  return (
    <button
      type="button"
      className="pick"
      aria-label={`${label}: ${current?.label ?? ""}. Click to change.`}
      onClick={() => advance(1)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
          event.preventDefault();
          event.stopPropagation();
          advance(-1);
        } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          advance(1);
        }
      }}
    >
      {current?.label}
    </button>
  );
}
