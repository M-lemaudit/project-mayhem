import { cn } from '@/lib/utils';

interface StatProps {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  children?: React.ReactNode;
}

/** A hero figure: eyebrow label, large serif numeral, optional sub-line / sparkline. */
export function Stat({ label, value, sub, accent, children }: StatProps) {
  return (
    <div className="flex flex-col gap-1">
      <p className="eyebrow">{label}</p>
      <p
        className={cn(
          'font-display tabular leading-none',
          'text-[clamp(1.9rem,3.4vw,2.8rem)]',
          accent ? 'text-accent' : 'text-ink'
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
      {children}
    </div>
  );
}
