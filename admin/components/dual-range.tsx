'use client';

/** Two-thumb range on a single track, restyled to Atelier (accent thumbs, hairline track). */
interface DualRangeProps {
  bound: [number, number];
  value: [number, number];
  step?: number;
  onChange: (next: [number, number]) => void;
}

const THUMB =
  'pointer-events-none absolute h-1 w-full appearance-none bg-transparent ' +
  '[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none ' +
  '[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full ' +
  '[&::-webkit-slider-thumb]:bg-surface [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-accent ' +
  '[&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-sm ' +
  '[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full ' +
  '[&::-moz-range-thumb]:bg-surface [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-accent ' +
  '[&::-moz-range-thumb]:cursor-pointer';

export function DualRange({ bound, value, step = 1, onChange }: DualRangeProps) {
  const [lo, hi] = bound;
  const [vMin, vMax] = value;
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;

  return (
    <div className="relative flex h-6 items-center">
      <div className="absolute h-1 w-full rounded-full bg-paper" />
      <div
        className="absolute h-1 rounded-full bg-accent"
        style={{ left: `${pct(vMin)}%`, right: `${100 - pct(vMax)}%` }}
      />
      <input
        type="range"
        min={lo}
        max={hi}
        step={step}
        value={vMin}
        onChange={(e) => onChange([Math.min(Number(e.target.value), vMax), vMax])}
        className={`${THUMB} ${vMin > (lo + hi) / 2 ? 'z-30' : 'z-20'}`}
      />
      <input
        type="range"
        min={lo}
        max={hi}
        step={step}
        value={vMax}
        onChange={(e) => onChange([vMin, Math.max(Number(e.target.value), vMin)])}
        className={`${THUMB} z-20`}
      />
    </div>
  );
}
