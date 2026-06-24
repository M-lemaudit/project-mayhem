import { cn } from '@/lib/utils';

export type BotStatusLabel = 'Active' | 'Standby' | 'Error';

export function statusLabelOf(status: string): BotStatusLabel {
  if (status === 'RUNNING') return 'Active';
  if (status === 'ERROR_AUTH') return 'Error';
  return 'Standby';
}

const COLOR: Record<BotStatusLabel, string> = {
  Active: 'bg-accent',
  Standby: 'bg-muted/50',
  Error: 'bg-danger',
};

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const label = statusLabelOf(status);
  return (
    <span
      className={cn('inline-block h-2 w-2 rounded-full', COLOR[label], className)}
      aria-label={label}
    >
      {label === 'Active' && (
        <span className="block h-2 w-2 rounded-full bg-accent animate-ping opacity-60" />
      )}
    </span>
  );
}
