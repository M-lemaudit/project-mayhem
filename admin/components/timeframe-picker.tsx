'use client';

import { PRESETS, type PresetKey } from '@/lib/timeframe';
import { cn } from '@/lib/utils';

interface TimeframePickerProps {
  preset: PresetKey;
  onPreset: (p: PresetKey) => void;
  customStart: string;
  customEnd: string;
  onCustomStart: (v: string) => void;
  onCustomEnd: (v: string) => void;
}

export function TimeframePicker({
  preset,
  onPreset,
  customStart,
  customEnd,
  onCustomStart,
  onCustomEnd,
}: TimeframePickerProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-hairline bg-surface p-0.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onPreset(p.key)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              preset === p.key ? 'bg-accent text-paper' : 'text-muted hover:text-ink'
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={customStart}
            onChange={(e) => onCustomStart(e.target.value)}
            className="rounded-lg border border-hairline bg-surface px-3 py-1.5 text-xs text-ink outline-none focus:border-accent"
          />
          <span className="text-muted">→</span>
          <input
            type="date"
            value={customEnd}
            onChange={(e) => onCustomEnd(e.target.value)}
            className="rounded-lg border border-hairline bg-surface px-3 py-1.5 text-xs text-ink outline-none focus:border-accent"
          />
        </div>
      )}
    </div>
  );
}
