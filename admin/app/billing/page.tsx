'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, BILLING_FEE_RATE, type BotRow, type AcceptedOfferRow } from '@/lib/supabase';
import { FullPageLoader } from '@/components/full-page-loader';

/** A completed (reconciled) ride enriched with its owning bot label. */
interface CompletedRide extends AcceptedOfferRow {
  botName: string;
}

interface MonthGroup {
  monthKey: string; // YYYY-MM
  monthLabel: string; // e.g. "June 2026"
  currency: string;
  count: number;
  gross: number;
  fee: number;
  perBot: { botName: string; count: number; gross: number; fee: number }[];
}

type PresetKey = 'this_month' | 'last_month' | 'last_3_months' | 'this_year' | 'all_time' | 'custom';

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'last_3_months', label: 'Last 3 Months' },
  { key: 'this_year', label: 'This Year' },
  { key: 'all_time', label: 'All Time' },
  { key: 'custom', label: 'Custom' },
];

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(
      amount
    );
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function monthLabelOf(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Returns the [start, end) instants for a preset (custom uses the two date inputs). */
function rangeFor(preset: PresetKey, customStart: string, customEnd: string): [number, number] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (preset) {
    case 'this_month':
      return [new Date(y, m, 1).getTime(), Infinity];
    case 'last_month':
      return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()];
    case 'last_3_months':
      return [new Date(y, m - 2, 1).getTime(), Infinity];
    case 'this_year':
      return [new Date(y, 0, 1).getTime(), Infinity];
    case 'custom': {
      const start = customStart ? new Date(customStart).getTime() : -Infinity;
      // Inclusive end-of-day for the picked end date.
      const end = customEnd ? new Date(customEnd).getTime() + 24 * 60 * 60_000 : Infinity;
      return [start, end];
    }
    case 'all_time':
    default:
      return [-Infinity, Infinity];
  }
}

function buildMonthGroups(rides: CompletedRide[]): MonthGroup[] {
  const byMonth = new Map<string, CompletedRide[]>();
  for (const r of rides) {
    if (!r.completed_at) continue;
    const key = r.completed_at.slice(0, 7);
    const list = byMonth.get(key) ?? [];
    list.push(r);
    byMonth.set(key, list);
  }

  const groups: MonthGroup[] = [];
  for (const [key, list] of Array.from(byMonth.entries())) {
    const currency = list.find((r) => r.finished_currency)?.finished_currency ?? 'USD';
    const perBotMap = new Map<string, { count: number; gross: number }>();
    let gross = 0;
    for (const r of list) {
      const price = r.finished_price ?? 0;
      gross += price;
      const agg = perBotMap.get(r.botName) ?? { count: 0, gross: 0 };
      agg.count += 1;
      agg.gross += price;
      perBotMap.set(r.botName, agg);
    }
    const perBot = Array.from(perBotMap.entries())
      .map(([botName, v]) => ({ botName, count: v.count, gross: v.gross, fee: v.gross * BILLING_FEE_RATE }))
      .sort((a, b) => b.gross - a.gross);

    groups.push({
      monthKey: key,
      monthLabel: monthLabelOf(key),
      currency,
      count: list.length,
      gross,
      fee: gross * BILLING_FEE_RATE,
      perBot,
    });
  }
  return groups.sort((a, b) => (a.monthKey < b.monthKey ? 1 : -1));
}

export default function BillingPage() {
  const router = useRouter();
  const [rides, setRides] = useState<CompletedRide[]>([]);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = useState<PresetKey>('this_month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  useEffect(() => {
    const fetchData = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push('/login');
        return;
      }

      // User-scoped isolation (RLS also enforces this server-side).
      const { data: bots, error: botErr } = await supabase
        .from('bots')
        .select('id, name, email')
        .eq('user_id', user.id);
      if (botErr) {
        console.error('Failed to fetch bots', { errorMessage: botErr.message });
        return;
      }
      const botList = (bots as Pick<BotRow, 'id' | 'name' | 'email'>[]) ?? [];
      if (botList.length === 0) {
        setRides([]);
        return;
      }
      const nameById = new Map(botList.map((b) => [b.id, b.name || b.email]));

      // Only reconciled (= completed & matched) offers are billable.
      const { data: offers, error: offerErr } = await supabase
        .from('accepted_offers')
        .select('id, bot_id, completed_status, finished_price, finished_currency, completed_at, booking_number')
        .in('bot_id', botList.map((b) => b.id))
        .not('reconciled_at', 'is', null)
        .order('completed_at', { ascending: false });
      if (offerErr) {
        console.error('Failed to fetch completed offers', { errorMessage: offerErr.message });
        return;
      }
      const enriched: CompletedRide[] = ((offers as AcceptedOfferRow[]) ?? []).map((o) => ({
        ...o,
        botName: nameById.get(o.bot_id) ?? o.bot_id,
      }));
      setRides(enriched);
    };

    fetchData().finally(() => setLoading(false));
  }, [router]);

  // Rides within the selected timeframe.
  const filtered = useMemo(() => {
    const [start, end] = rangeFor(preset, customStart, customEnd);
    return rides.filter((r) => {
      if (!r.completed_at) return false;
      const t = new Date(r.completed_at).getTime();
      return t >= start && t < end;
    });
  }, [rides, preset, customStart, customEnd]);

  const months = useMemo(() => buildMonthGroups(filtered), [filtered]);

  // Headline totals for the selected timeframe, split by currency (usually just one).
  const totals = useMemo(() => {
    const byCur = new Map<string, { gross: number; fee: number; count: number }>();
    for (const r of filtered) {
      const cur = r.finished_currency || 'USD';
      const price = r.finished_price ?? 0;
      const agg = byCur.get(cur) ?? { gross: 0, fee: 0, count: 0 };
      agg.gross += price;
      agg.fee += price * BILLING_FEE_RATE;
      agg.count += 1;
      byCur.set(cur, agg);
    }
    return Array.from(byCur.entries()).map(([currency, v]) => ({ currency, ...v }));
  }, [filtered]);

  const totalRides = filtered.length;
  const presetLabel = PRESETS.find((p) => p.key === preset)?.label ?? '';

  if (loading) {
    return <FullPageLoader message="Loading billing…" />;
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-slate-100 font-[Inter,sans-serif]">
      <header className="border-b border-neutral-800 bg-[#0a0a0a]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1100px] mx-auto px-6 h-20 flex items-center justify-between">
          <button
            type="button"
            onClick={() => router.push('/dashboard')}
            className="flex items-center gap-2 text-slate-400 hover:text-[#d4af35] transition-colors"
          >
            <span className="material-symbols-outlined">arrow_back</span>
            <span className="text-sm font-semibold uppercase tracking-widest">Dashboard</span>
          </button>
          <h1 className="text-xl font-light tracking-luxury uppercase text-slate-100">
            Billing <span className="font-bold">&amp; Fees</span>
          </h1>
        </div>
      </header>

      <div className="max-w-[1100px] mx-auto w-full p-8">
        <div className="mb-8">
          <h2 className="text-3xl font-light tracking-tight text-slate-100">Completed Ride Billing</h2>
          <p className="text-slate-500 mt-1">
            {(BILLING_FEE_RATE * 100).toFixed(0)}% of every ride the bot booked that was actually
            completed on Blacklane (status finished or no-show).
          </p>
        </div>

        {/* Timeframe selector */}
        <div className="flex flex-wrap items-center gap-2 mb-6">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              className={`px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-widest transition-colors border ${
                preset === p.key
                  ? 'bg-[#d4af35] text-black border-[#d4af35]'
                  : 'bg-[#141414] text-slate-400 border-[#262626] hover:text-[#d4af35]'
              }`}
            >
              {p.label}
            </button>
          ))}
          {preset === 'custom' && (
            <div className="flex items-center gap-2 ml-2">
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="bg-[#141414] border border-[#262626] rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#d4af35]"
              />
              <span className="text-slate-600">→</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="bg-[#141414] border border-[#262626] rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#d4af35]"
              />
            </div>
          )}
        </div>

        {/* Total due summary */}
        <section className="glass-card rounded-2xl p-8 mb-8 border border-[#d4af35]/20 bg-gradient-to-br from-[#d4af35]/[0.06] to-transparent">
          <p className="text-[10px] uppercase tracking-ultra-wide text-slate-500 mb-2">
            Total Due — {presetLabel}
          </p>
          {totals.length === 0 ? (
            <p className="text-4xl font-light text-slate-300">{money(0, 'USD')}</p>
          ) : (
            <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
              {totals.map((t) => (
                <div key={t.currency}>
                  <p className="text-4xl font-bold text-[#d4af35] tracking-tight">
                    {money(t.fee, t.currency)}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    on {money(t.gross, t.currency)} gross · {t.count} ride{t.count === 1 ? '' : 's'}
                  </p>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-slate-600 mt-4">
            {totalRides} completed ride{totalRides === 1 ? '' : 's'} in this period ·{' '}
            {(BILLING_FEE_RATE * 100).toFixed(0)}% fee
          </p>
        </section>

        {/* Monthly breakdown */}
        {months.length === 0 ? (
          <div className="glass-card p-10 rounded-2xl text-center text-slate-500">
            No completed rides in this timeframe yet. Once rides pass and the reconciler runs,
            billing will appear here.
          </div>
        ) : (
          <div className="space-y-6">
            <h3 className="text-sm font-semibold uppercase tracking-widest text-slate-500">
              Monthly Breakdown
            </h3>
            {months.map((m) => (
              <section key={m.monthKey} className="glass-card p-6 rounded-2xl">
                <div className="flex flex-wrap items-end justify-between gap-4 mb-5 pb-5 border-b border-white/5">
                  <div>
                    <h4 className="text-xl font-semibold text-slate-100">{m.monthLabel}</h4>
                    <p className="text-xs text-slate-500 mt-1">
                      {m.count} completed ride{m.count === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex gap-8 text-right">
                    <div>
                      <p className="text-[9px] uppercase tracking-ultra-wide text-slate-600 mb-1">Gross</p>
                      <p className="text-sm font-medium text-slate-200">{money(m.gross, m.currency)}</p>
                    </div>
                    <div>
                      <p className="text-[9px] uppercase tracking-ultra-wide text-slate-600 mb-1">
                        Fee ({(BILLING_FEE_RATE * 100).toFixed(0)}%)
                      </p>
                      <p className="text-sm font-bold text-[#d4af35]">{money(m.fee, m.currency)}</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  {m.perBot.map((b) => (
                    <div key={b.botName} className="flex items-center justify-between text-sm py-1.5">
                      <span className="text-slate-300">{b.botName}</span>
                      <span className="text-slate-500">
                        {b.count} ride{b.count === 1 ? '' : 's'} · {money(b.gross, m.currency)} ·{' '}
                        <span className="text-[#d4af35] font-medium">{money(b.fee, m.currency)} fee</span>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
