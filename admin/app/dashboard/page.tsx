'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Plus, Trash2, ArrowUpRight, Rocket } from 'lucide-react';
import { supabase, type BotRow, type AcceptedOfferRow } from '@/lib/supabase';
import { addClient, deleteClient } from '@/app/actions/bots';
import { AppShell } from '@/components/app-shell';
import { Stat } from '@/components/stat';
import { TimeframePicker } from '@/components/timeframe-picker';
import { EarningsChart } from '@/components/earnings-chart';
import { CatchBoard } from '@/components/catch-board';
import { Sparkline } from '@/components/sparkline';
import { StatusDot } from '@/components/status-dot';
import { FullPageLoader } from '@/components/full-page-loader';
import { rangeFor, money, inRange, type PresetKey } from '@/lib/timeframe';
import {
  madePayBooked,
  bucketSeries,
  aggregateByBot,
  primaryCurrency,
} from '@/lib/metrics';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const OFFER_COLUMNS =
  'id, bot_id, offer_id, price, pickup_at, pickup_address, dropoff_address, created_at, finished_price, finished_currency, completed_at, reconciled_at';

function timeAgo(iso?: string): string {
  if (!iso) return 'No catches yet';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'Just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function DashboardPage() {
  const router = useRouter();
  const [bots, setBots] = useState<BotRow[]>([]);
  const [offers, setOffers] = useState<AcceptedOfferRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [preset, setPreset] = useState<PresetKey>('this_month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  // Add-account modal
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [adding, setAdding] = useState(false);
  const [toDelete, setToDelete] = useState<{ id: string; name: string } | null>(null);

  const fetchAll = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push('/login');
      return;
    }
    const { data: botData } = await supabase
      .from('bots')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    const botList = (botData as BotRow[]) ?? [];
    setBots(botList);

    if (botList.length > 0) {
      const { data: offerData } = await supabase
        .from('accepted_offers')
        .select(OFFER_COLUMNS)
        .in('bot_id', botList.map((b) => b.id))
        .order('created_at', { ascending: false })
        .limit(3000);
      setOffers((offerData as AcceptedOfferRow[]) ?? []);
    } else {
      setOffers([]);
    }
  };

  useEffect(() => {
    fetchAll().finally(() => setLoading(false));
    const channel = supabase
      .channel('dashboard-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bots' }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'accepted_offers' }, fetchAll)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const range = useMemo(() => rangeFor(preset, customStart, customEnd), [preset, customStart, customEnd]);
  const metrics = useMemo(() => madePayBooked(offers, range), [offers, range]);
  const series = useMemo(() => bucketSeries(offers, range), [offers, range]);
  const byBot = useMemo(() => aggregateByBot(offers, range), [offers, range]);
  const botsById = useMemo(
    () => bots.reduce<Record<string, BotRow>>((a, b) => ((a[b.id] = b), a), {}),
    [bots]
  );

  // Bookings per active day, for the small sparkline under "Rides booked".
  const bookedBars = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of offers) {
      if (o.created_at && inRange(new Date(o.created_at).getTime(), range)) {
        const k = o.created_at.slice(0, 10);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
    }
    return Array.from(m.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, v]) => v)
      .slice(-30);
  }, [offers, range]);

  const cur = primaryCurrency(metrics.byCurrency);
  const main = metrics.byCurrency.find((c) => c.currency === cur);
  const made = main?.made ?? 0;
  const completed = main?.completed ?? 0;
  const avg = completed > 0 ? made / completed : 0;
  const extraCurrencies = metrics.byCurrency.filter((c) => c.currency !== cur);
  const activeBots = bots.filter((b) => b.status === 'RUNNING').length;
  const maxBotMade = Math.max(1, ...Object.values(byBot).map((b) => b.made));

  const handleCreate = async () => {
    if (!newEmail || !newPassword) return;
    setAdding(true);
    try {
      const result = await addClient({
        name: newName,
        email: newEmail,
        password: newPassword,
        minPrice: 50,
        vehicleTypes: ['first'],
        timezone: 'Europe/Paris',
        locale: 'en-GB',
        latitude: 48.8566,
        longitude: 2.3522,
      });
      if (result.error) alert('Could not create account: ' + result.error);
      else if (result.data) router.push(`/accounts/${result.data.id}`);
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async () => {
    if (!toDelete) return;
    const result = await deleteClient(toDelete.id);
    if ((result as { error?: string })?.error) {
      alert('Could not delete account: ' + (result as { error?: string }).error);
      return;
    }
    setBots((prev) => prev.filter((b) => b.id !== toDelete.id));
    setToDelete(null);
    fetchAll();
  };

  if (loading) return <FullPageLoader message="Loading your fleet desk…" />;

  return (
    <AppShell>
      {/* Title + timeframe */}
      <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-display text-3xl text-ink md:text-4xl">Overview</h1>
          <p className="mt-1 text-sm text-muted">
            {bots.length} bot{bots.length === 1 ? '' : 's'} · {activeBots} active
          </p>
        </div>
        <TimeframePicker
          preset={preset}
          onPreset={setPreset}
          customStart={customStart}
          customEnd={customEnd}
          onCustomStart={setCustomStart}
          onCustomEnd={setCustomEnd}
        />
      </div>

      {/* Hero stats */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-hairline bg-hairline">
        <div className="bg-surface p-5 md:p-6">
          <Stat
            label="You made"
            value={money(made, cur)}
            sub={avg > 0 ? `${money(avg, cur)} avg / ride` : `${completed} booked ride${completed === 1 ? '' : 's'}`}
          />
          {extraCurrencies.length > 0 && (
            <p className="mt-1 text-xs text-muted">
              + {extraCurrencies.map((c) => money(c.made, c.currency)).join(' · ')}
            </p>
          )}
        </div>
        <div className="bg-surface p-5 md:p-6">
          <Stat label="Rides booked" value={String(metrics.booked)} sub="Caught this period">
            <div className="mt-2">
              <Sparkline values={bookedBars} variant="bars" width={120} height={24} />
            </div>
          </Stat>
        </div>
      </div>

      {/* Earnings chart */}
      <section className="mt-6 rounded-2xl border border-hairline bg-surface p-5 md:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="eyebrow !text-ink">Earnings</h2>
          <div className="flex items-center gap-4 text-[11px] text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-accent" /> Made
            </span>
          </div>
        </div>
        <EarningsChart points={series.points} currency={series.currency} />
      </section>

      {/* Catch board */}
      <div className="mt-6">
        <CatchBoard mode="global" botsById={botsById} />
      </div>

      {/* Fleet */}
      <section className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-xl text-ink">Fleet</h2>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-2 rounded-lg border border-hairline bg-surface px-3 py-1.5 text-sm text-ink transition-colors hover:border-ink/30"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} /> Add bot
          </button>
        </div>

        {bots.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-hairline bg-surface p-10 text-center">
            <p className="text-sm text-muted">No bots yet. Add your first account to start catching rides.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-hairline bg-surface">
            {bots.map((bot) => {
              const agg = byBot[bot.id] ?? { made: 0, pay: 0, booked: 0, currency: cur };
              return (
                <div
                  key={bot.id}
                  className="group flex items-center gap-4 border-b border-hairline px-5 py-4 last:border-0 hover:bg-paper md:px-6"
                >
                  <Link href={`/accounts/${bot.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                    <StatusDot status={bot.status} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{bot.name || bot.email}</p>
                      <p className="truncate text-xs text-muted">{timeAgo(agg.lastCatch)}</p>
                    </div>
                  </Link>

                  {/* Contribution bar */}
                  <div className="hidden w-24 md:block">
                    <div className="h-1.5 overflow-hidden rounded-full bg-paper">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${Math.round((agg.made / maxBotMade) * 100)}%` }}
                      />
                    </div>
                  </div>

                  <div className="hidden w-20 text-right md:block">
                    <p className="eyebrow text-[10px]">Booked</p>
                    <p className="font-mono text-sm text-ink">{agg.booked}</p>
                  </div>
                  <div className="w-28 text-right">
                    <p className="eyebrow text-[10px]">Made</p>
                    <p className="font-display tabular text-sm text-ink">{money(agg.made, agg.currency)}</p>
                  </div>

                  <div className="flex items-center gap-2">
                    <Link
                      href={`/accounts/${bot.id}`}
                      className="text-muted transition-colors group-hover:text-accent"
                      aria-label="Open bot"
                    >
                      <ArrowUpRight className="h-4 w-4" />
                    </Link>
                    <button
                      type="button"
                      onClick={() => setToDelete({ id: bot.id, name: bot.name || bot.email })}
                      aria-label="Delete bot"
                      className="text-muted/50 transition-colors hover:text-danger"
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Add account dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a bot</DialogTitle>
            <p className="mt-1 text-sm text-muted">Connect a Blacklane account to start catching rides.</p>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Label">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Paris Fleet"
                className="w-full rounded-lg border border-hairline bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
              />
            </Field>
            <Field label="Blacklane email">
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="connect@blacklane.com"
                className="w-full rounded-lg border border-hairline bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full rounded-lg border border-hairline bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
              />
            </Field>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              className="rounded-lg border border-hairline bg-surface px-4 py-2 text-sm text-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={adding || !newEmail || !newPassword}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-paper hover:bg-accent-hover disabled:opacity-50"
            >
              <Rocket className="h-4 w-4" strokeWidth={1.75} />
              {adding ? 'Connecting…' : 'Add bot'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete bot</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted">
            Delete <span className="font-medium text-ink">{toDelete?.name}</span> and all its settings? This
            cannot be undone.
          </p>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setToDelete(null)}
              className="rounded-lg border border-hairline bg-surface px-4 py-2 text-sm text-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted">{label}</label>
      {children}
    </div>
  );
}
