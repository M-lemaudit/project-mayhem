'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { supabase, type BotRow, type AcceptedOfferRow } from '@/lib/supabase';
import { money } from '@/lib/timeframe';

type Mode = 'global' | 'bot';

interface CatchBoardProps {
  mode: Mode;
  botId?: string;
  botsById?: Record<string, BotRow>;
}

const COLLAPSED = 6;
const EXPANDED = 24;

/** Caught time — to the second; that precision is the whole point of a sniper. */
function caughtTime(value: string): { time: string; date: string } {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { time: value, date: '' };
  return {
    time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
    date: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
  };
}

/** Ride time — the scheduled pickup. */
function rideTime(value?: string | null): { time: string; date: string } {
  if (!value) return { time: '—', date: '' };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { time: value, date: '' };
  return {
    time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    date: d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }),
  };
}

function route(row: AcceptedOfferRow): string {
  const a = row.pickup_address ?? '';
  const b = row.dropoff_address ?? '';
  if (a && b) return `${a}  →  ${b}`;
  return a || b || `Offer ${row.offer_id}`;
}

function priceLabel(row: AcceptedOfferRow): string {
  if (row.finished_price != null) return money(row.finished_price, row.finished_currency || 'EUR');
  if (row.price != null && row.price !== '') {
    const n = Number(row.price);
    return Number.isFinite(n) ? money(n, 'EUR') : `${row.price}`;
  }
  return '—';
}

export function CatchBoard({ mode, botId, botsById }: CatchBoardProps) {
  const [rows, setRows] = useState<AcceptedOfferRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const byId = botsById ?? {};

  // Data isolation: only ever show offers for bots the viewer owns.
  const allowedBotIds = mode === 'bot' ? (botId ? [botId] : []) : Object.keys(byId);
  const allowedKey = allowedBotIds.slice().sort().join(',');

  useEffect(() => {
    let mounted = true;
    const allowed = new Set(allowedKey ? allowedKey.split(',') : []);

    async function fetchRows() {
      setLoading(true);
      if (allowed.size === 0) {
        if (mounted) {
          setRows([]);
          setLoading(false);
        }
        return;
      }
      const { data, error } = await supabase
        .from('accepted_offers')
        .select(
          'id, bot_id, offer_id, price, pickup_at, pickup_address, dropoff_address, created_at, finished_price, finished_currency'
        )
        .order('created_at', { ascending: false })
        .limit(200)
        .in('bot_id', Array.from(allowed));
      if (!mounted) return;
      if (error) {
        console.error('CatchBoard fetch failed', { errorMessage: error.message });
        setRows([]);
      } else {
        setRows((data as AcceptedOfferRow[]) ?? []);
      }
      setLoading(false);
    }

    fetchRows();

    const channel = supabase
      .channel('catch-board')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'accepted_offers' },
        (payload: { new: AcceptedOfferRow | null }) => {
          const row = payload.new;
          if (!mounted || !row || !allowed.has(row.bot_id)) return;
          setRows((prev) => {
            const idx = prev.findIndex((r) => r.id === row.id);
            const next = idx >= 0 ? [...prev] : [row, ...prev];
            if (idx >= 0) next[idx] = row;
            return next
              .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
              .slice(0, 200);
          });
        }
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, [allowedKey]);

  const visible = useMemo(() => rows.slice(0, expanded ? EXPANDED : COLLAPSED), [rows, expanded]);

  return (
    <section className="rounded-2xl border border-hairline bg-surface">
      <div className="flex items-center justify-between border-b border-hairline px-5 py-4 md:px-6">
        <h3 className="eyebrow !text-ink">Recent catches</h3>
        <span className="flex items-center gap-2 text-[11px] text-accent">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
          Live
        </span>
      </div>

      {loading && rows.length === 0 ? (
        <p className="px-6 py-8 text-sm text-muted">Loading catches…</p>
      ) : rows.length === 0 ? (
        <p className="px-6 py-8 text-sm text-muted">
          No rides caught yet. When a bot books a ride, it lands here in real time.
        </p>
      ) : (
        <>
          <div>
            {visible.map((row) => {
              const bot = byId[row.bot_id];
              const caught = caughtTime(row.created_at);
              const ride = rideTime(row.pickup_at);
              return (
                <div
                  key={row.id}
                  className="rise grid grid-cols-1 gap-3 border-b border-hairline px-5 py-4 last:border-0 md:grid-cols-[auto_1fr_auto] md:items-center md:gap-6 md:px-6"
                >
                  {/* Caught → Ride timestamps */}
                  <div className="flex items-center gap-4">
                    <div>
                      <p className="eyebrow text-[10px]">Caught</p>
                      <p className="font-mono text-sm text-ink">{caught.time}</p>
                      <p className="font-mono text-[10px] text-muted">{caught.date}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted/50" strokeWidth={1.5} />
                    <div>
                      <p className="eyebrow text-[10px]">Ride</p>
                      <p className="font-mono text-sm text-ink">{ride.time}</p>
                      <p className="font-mono text-[10px] text-muted">{ride.date}</p>
                    </div>
                  </div>

                  {/* Route + bot */}
                  <div className="min-w-0">
                    {mode === 'global' && (
                      <p className="eyebrow text-[10px]">{bot?.name || bot?.email || 'Bot'}</p>
                    )}
                    <p className="truncate text-sm text-ink/90">{route(row)}</p>
                  </div>

                  {/* Price */}
                  <p className="font-display tabular text-lg text-ink md:text-right">{priceLabel(row)}</p>
                </div>
              );
            })}
          </div>

          {rows.length > COLLAPSED && (
            <div className="border-t border-hairline px-6 py-3">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="text-xs font-medium text-muted transition-colors hover:text-accent"
              >
                {expanded ? 'Show less' : `Show more (${rows.length - COLLAPSED} more)`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
