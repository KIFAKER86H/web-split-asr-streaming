"use client";

import { useEffect, useState, type RefObject } from "react";

const BAR_COUNT = 18;

// Bell-shaped envelope so the bars read as a waveform instead of a flat block.
const ENVELOPE = Array.from({ length: BAR_COUNT }, (_, index) =>
  Math.sin((Math.PI * index) / (BAR_COUNT - 1)) ** 0.7,
);

interface LevelMeterProps {
  levelRef: RefObject<number>;
  active: boolean;
}

/**
 * Reads the loudness from a ref on every animation frame, so the sixty updates
 * a second stay inside this component instead of re-rendering the page.
 */
export function LevelMeter({ levelRef, active }: LevelMeterProps) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!active) {
      return;
    }

    let frame = requestAnimationFrame(function tick() {
      setLevel(levelRef.current);
      frame = requestAnimationFrame(tick);
    });

    return () => cancelAnimationFrame(frame);
  }, [active, levelRef]);

  const displayed = active ? level : 0;

  return (
    <div className="flex h-6 items-center gap-[3px]" aria-hidden="true">
      {ENVELOPE.map((weight, index) => (
        <span
          key={index}
          className={`w-[2px] rounded-full transition-[height] duration-75 ${
            active ? "bg-accent/90" : "bg-white/15"
          }`}
          style={{ height: `${12 + displayed * weight * 88}%` }}
        />
      ))}
    </div>
  );
}
