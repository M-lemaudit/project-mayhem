/** Tiny inline SVG sparkline / mini-bars. No deps — full control of the minimal look. */
interface SparklineProps {
  values: number[];
  variant?: 'line' | 'bars';
  width?: number;
  height?: number;
  className?: string;
}

export function Sparkline({
  values,
  variant = 'line',
  width = 120,
  height = 28,
  className,
}: SparklineProps) {
  if (values.length === 0) {
    return <div style={{ width, height }} className={className} aria-hidden />;
  }
  const max = Math.max(...values, 1);
  const accent = 'var(--accent)';

  if (variant === 'bars') {
    const n = values.length;
    const gap = n > 1 ? 2 : 0;
    const bw = (width - gap * (n - 1)) / n;
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        width={width}
        height={height}
        className={className}
        aria-hidden
        role="img"
      >
        {values.map((v, i) => {
          const h = Math.max(1, (v / max) * height);
          return (
            <rect
              key={i}
              x={i * (bw + gap)}
              y={height - h}
              width={bw}
              height={h}
              rx={Math.min(1.5, bw / 2)}
              fill={accent}
              opacity={v === 0 ? 0.15 : 0.85}
            />
          );
        })}
      </svg>
    );
  }

  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const pts = values.map((v, i) => [i * stepX, height - (v / max) * (height - 2) - 1]);
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width={width}
      height={height}
      className={className}
      aria-hidden
      role="img"
    >
      <path d={area} fill={accent} opacity={0.08} />
      <path d={line} fill="none" stroke={accent} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
