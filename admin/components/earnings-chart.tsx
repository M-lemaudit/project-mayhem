'use client';

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts';
import type { SeriesPoint } from '@/lib/metrics';
import { money } from '@/lib/timeframe';

function compact(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'EUR',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n);
  } catch {
    return `${Math.round(n)}`;
  }
}

interface TooltipPayload {
  active?: boolean;
  payload?: { payload: SeriesPoint }[];
  currency: string;
}

function ChartTooltip({ active, payload, currency }: TooltipPayload) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-hairline bg-surface px-3 py-2 shadow-[0_12px_30px_-12px_rgba(22,20,15,0.25)]">
      <p className="mb-1 text-xs font-medium text-ink">{p.label}</p>
      <p className="font-mono text-xs text-accent">Made {money(p.made, currency)}</p>
      <p className="font-mono text-[11px] text-muted/80">
        {p.count} ride{p.count === 1 ? '' : 's'}
      </p>
    </div>
  );
}

export function EarningsChart({ points, currency }: { points: SeriesPoint[]; currency: string }) {
  if (points.length === 0) {
    return (
      <div className="flex h-[240px] items-center justify-center rounded-xl border border-dashed border-hairline text-sm text-muted">
        No completed rides in this period yet.
      </div>
    );
  }

  return (
    <div className="h-[240px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="madeFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.16} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: 'var(--hairline)' }}
            tick={{ fill: 'var(--muted)', fontSize: 11 }}
            minTickGap={28}
            interval="preserveStartEnd"
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={48}
            tick={{ fill: 'var(--muted)', fontSize: 11 }}
            tickFormatter={(v) => compact(Number(v), currency)}
          />
          <Tooltip
            cursor={{ stroke: 'var(--hairline)', strokeWidth: 1 }}
            content={<ChartTooltip currency={currency} />}
          />
          <Area
            type="monotone"
            dataKey="made"
            stroke="var(--accent)"
            strokeWidth={2}
            fill="url(#madeFill)"
            dot={false}
            activeDot={{ r: 3, fill: 'var(--accent)' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
