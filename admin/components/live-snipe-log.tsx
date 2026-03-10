'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase, type BotRow, type AcceptedOfferRow } from '@/lib/supabase';

const DEFAULT_PAGE_SIZE = 5;
const EXPANDED_PAGE_SIZE = 10;

type Mode = 'global' | 'bot';

interface LiveSnipeLogProps {
  mode: Mode;
  botId?: string;
  botsById?: Record<string, BotRow>;
}

function formatDateTime(value?: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function describeOffer(row: AcceptedOfferRow): string {
  const pickup = row.pickup_address ?? '';
  const dropoff = row.dropoff_address ?? '';
  if (pickup && dropoff) return `${pickup} → ${dropoff}`;
  if (pickup || dropoff) return pickup || dropoff;
  return `Offer ${row.offer_id}`;
}

function formatBotPrefix(bot: BotRow | undefined): string {
  if (!bot) return 'Bot';
  return bot.name || bot.email || 'Bot';
}

export function LiveSnipeLog({ mode, botId, botsById }: LiveSnipeLogProps) {
  const [logs, setLogs] = useState<AcceptedOfferRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showMore, setShowMore] = useState(false);
  const [page, setPage] = useState(0);

  const title = mode === 'global' ? 'Live Snipe Log' : 'Recent Activity';
  const filteredBotsById = botsById ?? {};

  useEffect(() => {
    let isMounted = true;

    async function fetchLogs() {
      setLoading(true);
      let query = supabase
        .from('accepted_offers')
        .select('id, bot_id, offer_id, price, pickup_at, pickup_address, dropoff_address, created_at')
        .order('created_at', { ascending: false })
        .limit(500);

      if (mode === 'bot' && botId) {
        query = query.eq('bot_id', botId);
      }

      const { data, error } = await query;
      if (!isMounted) return;
      if (error) {
        console.error('Failed to fetch accepted_offers for LiveSnipeLog:', error.message);
        setLogs([]);
      } else {
        setLogs((data as AcceptedOfferRow[]) ?? []);
      }
      setLoading(false);
    }

    fetchLogs();

    const channel = supabase
      .channel('accepted_offers-live-snipe-log')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'accepted_offers' },
        (payload: { new: AcceptedOfferRow | null }) => {
          if (!isMounted) return;
          const row = payload.new;
          if (!row) return;
          if (mode === 'bot' && botId && row.bot_id !== botId) return;
          setLogs((prev) => {
            const existingIdx = prev.findIndex((r) => r.id === row.id);
            const next = existingIdx >= 0 ? [...prev] : [row, ...prev];
            if (existingIdx >= 0) next[existingIdx] = row;
            return next
              .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
              .slice(0, 500);
          });
        }
      )
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, [mode, botId]);

  const totalPages = Math.max(1, Math.ceil(logs.length / EXPANDED_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const displayItems = useMemo(() => {
    if (!showMore) return logs.slice(0, DEFAULT_PAGE_SIZE);
    const start = currentPage * EXPANDED_PAGE_SIZE;
    return logs.slice(start, start + EXPANDED_PAGE_SIZE);
  }, [showMore, logs, currentPage]);

  const canShowMore = logs.length > DEFAULT_PAGE_SIZE;

  return (
    <div className="mt-16 bg-[#141414]/60 rounded-xl border border-[#262626] overflow-hidden glass-card">
      <div className="px-8 py-5 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
        <h3 className="text-[10px] font-bold tracking-ultra-wide uppercase text-slate-400">
          {title}
        </h3>
        <div className="flex items-center gap-2 text-[9px] uppercase tracking-ultra-wide text-[#d4af35]">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#d4af35] opacity-75" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#d4af35]" />
          </span>
          Live Stream
        </div>
      </div>

      {loading && logs.length === 0 ? (
        <div className="px-8 py-6 text-sm text-slate-500">Chargement des logs…</div>
      ) : logs.length === 0 ? (
        <div className="px-8 py-6 text-sm text-slate-500">Aucune course acceptée pour l’instant.</div>
      ) : (
        <>
          <div className="divide-y divide-white/5">
            {displayItems.map((row) => {
              const bot = filteredBotsById[row.bot_id];
              const label = describeOffer(row);
              const when = formatDateTime(row.pickup_at ?? row.created_at);
              const prefix = mode === 'global' ? formatBotPrefix(bot) : 'Bot';

              return (
                <div
                  key={row.id}
                  className="px-8 py-4 flex items-center justify-between hover:bg-white/[0.03] transition-colors group"
                >
                  <div className="flex items-center gap-5">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]" />
                    <div>
                      <p className="text-sm font-light text-slate-200">
                        {prefix} a book ce ride: <span className="text-slate-400">{label}</span>
                      </p>
                      <p className="text-[9px] text-slate-600 uppercase tracking-widest mt-0.5">
                        {when}
                        {row.price != null && row.price !== '' && (
                          <span className="ml-2 text-[#d4af35]">€{row.price}</span>
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {!showMore && canShowMore && (
            <div className="px-8 py-4 border-t border-white/5">
              <button
                type="button"
                onClick={() => { setShowMore(true); setPage(0); }}
                className="w-full py-3 text-[9px] font-bold tracking-ultra-wide uppercase text-slate-500 hover:text-[#d4af35] hover:bg-white/[0.03] transition-all border border-white/5 rounded-lg"
              >
                Afficher plus
              </button>
            </div>
          )}

          {showMore && totalPages > 1 && (
            <div className="px-8 py-4 border-t border-white/5 flex items-center justify-between gap-4">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={currentPage === 0}
                className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-400 hover:text-[#d4af35] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <span className="material-symbols-outlined text-lg">chevron_left</span>
                Précédent
              </button>
              <span className="text-[10px] text-slate-500 uppercase tracking-widest">
                Page {currentPage + 1} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={currentPage >= totalPages - 1}
                className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-400 hover:text-[#d4af35] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Suivant
                <span className="material-symbols-outlined text-lg">chevron_right</span>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
