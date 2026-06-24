'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, BILLING_FEE_RATE, type BotRow, type AcceptedOfferRow } from '@/lib/supabase';
import { AppShell } from '@/components/app-shell';
import { TimeframePicker } from '@/components/timeframe-picker';
import { FullPageLoader } from '@/components/full-page-loader';
import { rangeFor, money, monthLabelOf, type PresetKey, PRESETS } from '@/lib/timeframe';

interface CompletedRide extends AcceptedOfferRow {
  botName: string;
}

interface MonthGroup {
  monthKey: string;
  monthLabel: string;
  currency: string;
  count: number;
  gross: number;
  fee: number;
  perBot: { botName: string; count: number; gross: number; fee: number }[];
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
    const currency = list.find((r) => r.finished_currency)?.finished_currency ?? 'EUR';
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
      const { data: bots } = await supabase
        .from('bots')
        .select('id, name, email')
        .eq('user_id', user.id);
      const botList = (bots as Pick<BotRow, 'id' | 'name' | 'email'>[]) ?? [];
      if (botList.length === 0) {
        setRides([]);
        return;
      }
      const nameById = new Map(botList.map((b) => [b.id, b.name || b.email]));

      const { data: offers } = await supabase
        .from('accepted_offers')
        .select('id, bot_id, completed_status, finished_price, finished_currency, completed_at, booking_number')
        .in('bot_id', botList.map((b) => b.id))
        .not('reconciled_at', 'is', null)
        .order('completed_at', { ascending: false });
      const enriched: CompletedRide[] = ((offers as AcceptedOfferRow[]) ?? []).map((o) => ({
        ...o,
        botName: nameById.get(o.bot_id) ?? o.bot_id,
      }));
      setRides(enriched);
    };
    fetchData().finally(() => setLoading(false));
  }, [router]);

  const filtered = useMemo(() => {
    const [start, end] = rangeFor(preset, customStart, customEnd);
    return rides.filter((r) => {
      if (!r.completed_at) return false;
      const t = new Date(r.completed_at).getTime();
      return t >= start && t < end;
    });
  }, [rides, preset, customStart, customEnd]);

  const months = useMemo(() => buildMonthGroups(filtered), [filtered]);

  const totals = useMemo(() => {
    const byCur = new Map<string, { gross: number; fee: number; count: number }>();
    for (const r of filtered) {
      const cur = r.finished_currency || 'EUR';
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

  if (loading) return <FullPageLoader message="Loading billing…" />;

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="font-display text-3xl text-ink md:text-4xl">Billing</h1>
        <p className="mt-1 text-sm text-muted">
          {(BILLING_FEE_RATE * 100).toFixed(0)}% of every ride your bots booked that actually completed on
          Blacklane (finished or no-show).
        </p>
      </div>

      <div className="mb-6">
        <TimeframePicker
          preset={preset}
          onPreset={setPreset}
          customStart={customStart}
          customEnd={customEnd}
          onCustomStart={setCustomStart}
          onCustomEnd={setCustomEnd}
        />
      </div>

      {/* Total due */}
      <section className="rounded-2xl border border-hairline bg-surface p-6 md:p-8">
        <p className="eyebrow">Total due — {presetLabel}</p>
        {totals.length === 0 ? (
          <p className="mt-2 font-display text-4xl text-ink">{money(0, 'EUR')}</p>
        ) : (
          <div className="mt-2 flex flex-wrap items-end gap-x-10 gap-y-4">
            {totals.map((t) => (
              <div key={t.currency}>
                <p className="font-display tabular text-4xl text-accent md:text-5xl">{money(t.fee, t.currency)}</p>
                <p className="mt-1 text-xs text-muted">
                  on {money(t.gross, t.currency)} gross · {t.count} ride{t.count === 1 ? '' : 's'}
                </p>
              </div>
            ))}
          </div>
        )}
        <p className="mt-4 text-xs text-muted/80">
          {totalRides} completed ride{totalRides === 1 ? '' : 's'} this period · {(BILLING_FEE_RATE * 100).toFixed(0)}% fee
        </p>
      </section>

      {/* Monthly breakdown */}
      {months.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-hairline bg-surface p-10 text-center text-sm text-muted">
          No completed rides in this timeframe yet. Once rides pass and the reconciler runs, billing appears here.
        </div>
      ) : (
        <div className="mt-8 space-y-5">
          <h2 className="eyebrow">Monthly breakdown</h2>
          {months.map((m) => (
            <section key={m.monthKey} className="rounded-2xl border border-hairline bg-surface p-5 md:p-6">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-4 border-b border-hairline pb-4">
                <div>
                  <h3 className="font-display text-xl text-ink">{m.monthLabel}</h3>
                  <p className="mt-0.5 text-xs text-muted">
                    {m.count} completed ride{m.count === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="flex gap-8 text-right">
                  <div>
                    <p className="eyebrow text-[10px]">Gross</p>
                    <p className="font-display tabular text-sm text-ink">{money(m.gross, m.currency)}</p>
                  </div>
                  <div>
                    <p className="eyebrow text-[10px]">Fee ({(BILLING_FEE_RATE * 100).toFixed(0)}%)</p>
                    <p className="font-display tabular text-sm text-accent">{money(m.fee, m.currency)}</p>
                  </div>
                </div>
              </div>
              <div className="space-y-1.5">
                {m.perBot.map((b) => (
                  <div key={b.botName} className="flex items-center justify-between gap-3 py-1 text-sm">
                    <span className="min-w-0 truncate text-ink/90">{b.botName}</span>
                    <span className="shrink-0 text-right font-mono text-xs text-muted">
                      {b.count} · {money(b.gross, m.currency)} ·{' '}
                      <span className="text-accent">{money(b.fee, m.currency)} fee</span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </AppShell>
  );
}
