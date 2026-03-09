'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, type BotRow } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AddClientDialog } from '@/components/add-client-dialog';
import { EditClientDialog } from '@/components/edit-client-dialog';
import {
  addClient,
  deleteClient,
  toggleClientStatus,
  type UpdateClientInput,
} from '@/app/actions/bots';

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusVariant(status: string): 'running' | 'stopped' | 'error' | 'default' {
  switch (status) {
    case 'RUNNING':
      return 'running';
    case 'STOPPED':
      return 'stopped';
    case 'ERROR_AUTH':
    case 'PAUSED_RATE_LIMIT':
      return 'error';
    default:
      return 'default';
  }
}

function getMinPrice(filters: Record<string, unknown>): number | string {
  const v = filters?.minPrice;
  return typeof v === 'number' ? v : '—';
}

function getMinHours(filters: Record<string, unknown>): number | string {
  const v = filters?.minHoursFromNow;
  return typeof v === 'number' ? v : '—';
}

function getMinGap(filters: Record<string, unknown>): number | string {
  const v = filters?.minGapMinutes;
  return typeof v === 'number' && v >= 0 ? v : '—';
}

export default function DashboardPage() {
  const router = useRouter();
  const [bots, setBots] = useState<BotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [editBot, setEditBot] = useState<BotRow | null>(null);
  /** Keys of dismissed match notifications (bot.id + last_match.at) so they stay hidden for this session. */
  const [dismissedMatchKeys, setDismissedMatchKeys] = useState<Set<string>>(new Set());
  /** Global settings: delay between requests (ms). */
  const [delayMinMs, setDelayMinMs] = useState(1000);
  const [delayMaxMs, setDelayMaxMs] = useState(3000);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [showSavedToast, setShowSavedToast] = useState(false);

  const fetchBots = async () => {
    const { data, error } = await supabase
      .from('bots')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('Failed to fetch bots', error);
      return;
    }
    setBots((data as BotRow[]) ?? []);
  };

  const fetchGlobalSettings = async () => {
    const { data } = await supabase
      .from('global_settings')
      .select('sniper_delay_min_ms, sniper_delay_max_ms')
      .eq('id', 1)
      .maybeSingle();
    if (data) {
      setDelayMinMs(typeof data.sniper_delay_min_ms === 'number' ? data.sniper_delay_min_ms : 1000);
      setDelayMaxMs(typeof data.sniper_delay_max_ms === 'number' ? data.sniper_delay_max_ms : 3000);
    }
  };

  const saveGlobalSettings = async () => {
    const min = Math.max(100, Math.round(delayMinMs));
    const max = Math.max(min, Math.round(delayMaxMs));
    setSettingsSaving(true);
    const { error } = await supabase
      .from('global_settings')
      .upsert(
        {
          id: 1,
          sniper_delay_min_ms: min,
          sniper_delay_max_ms: max,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      );
    setSettingsSaving(false);
    if (error) {
      alert('Erreur: ' + error.message);
      return;
    }
    setShowSavedToast(true);
    setTimeout(() => setShowSavedToast(false), 2500);
  };

  useEffect(() => {
    fetchBots().finally(() => setLoading(false));
    fetchGlobalSettings();
    const channel = supabase
      .channel('bots-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bots' }, () => {
        fetchBots();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleLogout = async () => {
    const { createClient } = await import('@/lib/supabase/client');
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const handleToggle = async (bot: BotRow) => {
    const result = await toggleClientStatus(bot.id, bot.status);
    if (result.error) {
      alert(result.error);
      return;
    }
    if (result.data) {
      setBots((prev) =>
        prev.map((b) => (b.id === bot.id ? { ...b, status: result.data!.status } : b))
      );
    }
  };

  const handleDelete = async (bot: BotRow) => {
    if (!confirm(`Delete client "${bot.name || bot.email}"?`)) return;
    const result = await deleteClient(bot.id);
    if (result.error) {
      alert(result.error);
      return;
    }
    fetchBots();
  };

  const handleEditSuccess = () => {
    setEditBot(null);
    fetchBots();
  };

  const activeBots = bots.filter((b) => b.status === 'RUNNING').length;

  /** Bots that have a last_match, sorted by match time (newest first), excluding dismissed. */
  const botsWithMatch = bots
    .filter((b) => b.last_match && typeof b.last_match === 'object')
    .map((b) => ({ bot: b, last_match: b.last_match!, key: `${b.id}-${(b.last_match as { at: string }).at}` }))
    .filter(({ key }) => !dismissedMatchKeys.has(key))
    .sort((a, b) => new Date(b.last_match.at).getTime() - new Date(a.last_match.at).getTime());

  const dismissMatch = (key: string) => {
    setDismissedMatchKeys((prev) => new Set(prev).add(key));
  };
  const dismissAllMatches = () => {
    const allKeys = bots
      .filter((b) => b.last_match && typeof b.last_match === 'object')
      .map((b) => `${b.id}-${(b.last_match as { at: string }).at}`);
    setDismissedMatchKeys((prev) => {
      const next = new Set(prev);
      allKeys.forEach((k) => next.add(k));
      return next;
    });
  };

  function formatMatchTime(iso: string): string {
    try {
      return new Date(iso).toLocaleString(undefined, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen p-6 flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Toast "C'est enregistré" — discret, haut droite, style trophée */}
      {showSavedToast && (
        <div
          className="fixed top-4 right-4 z-50 flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-zinc-900/95 px-4 py-2.5 shadow-lg shadow-emerald-500/10 animate-in slide-in-from-right-5 fade-in duration-300"
          role="status"
          aria-live="polite"
        >
          <span className="text-lg" aria-hidden>🏆</span>
          <span className="text-sm font-medium text-emerald-400">C'est enregistré</span>
        </div>
      )}

      <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Sniper Admin HQ</h1>
        <Button variant="outline" size="sm" onClick={handleLogout}>
          Logout
        </Button>
      </header>

      <div className="p-6 space-y-6">
        {/* Paramètres généraux */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3">Paramètres généraux</h2>
          <p className="text-xs text-zinc-500 mb-3">
            Délai entre 2 requêtes (tous les bots) : un délai aléatoire entre min et max est appliqué à chaque cycle.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-zinc-500">Min (ms)</span>
              <input
                type="number"
                min={100}
                max={120000}
                value={delayMinMs}
                onChange={(e) => setDelayMinMs(Number(e.target.value) || 1000)}
                className="w-24 rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-zinc-100 font-mono text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-zinc-500">Max (ms)</span>
              <input
                type="number"
                min={100}
                max={120000}
                value={delayMaxMs}
                onChange={(e) => setDelayMaxMs(Number(e.target.value) || 3000)}
                className="w-24 rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-zinc-100 font-mono text-sm"
              />
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={saveGlobalSettings}
              disabled={settingsSaving}
            >
              {settingsSaving ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs text-zinc-500 uppercase tracking-wider">Total Clients</p>
            <p className="text-2xl font-mono font-semibold mt-1">{bots.length}</p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs text-zinc-500 uppercase tracking-wider">Active Bots</p>
            <p className="text-2xl font-mono font-semibold mt-1 text-emerald-400">
              {activeBots}
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs text-zinc-500 uppercase tracking-wider">Total Revenue</p>
            <p className="text-2xl font-mono font-semibold mt-1 text-zinc-500">—</p>
          </div>
        </div>

        {/* Table + Add */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-400">Clients</h2>
          <Button onClick={() => setAddOpen(true)}>Add Client</Button>
        </div>

        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/80">
                  <th className="text-left py-3 px-4 font-medium text-zinc-400">Name</th>
                  <th className="text-left py-3 px-4 font-medium text-zinc-400">Email</th>
                  <th className="text-left py-3 px-4 font-medium text-zinc-400">Status</th>
                  <th className="text-left py-3 px-4 font-medium text-zinc-400">Min Price</th>
                  <th className="text-left py-3 px-4 font-medium text-zinc-400">Min hours</th>
                  <th className="text-left py-3 px-4 font-medium text-zinc-400">Gap (min)</th>
                  <th className="text-left py-3 px-4 font-medium text-zinc-400">Last Seen</th>
                  <th className="text-right py-3 px-4 font-medium text-zinc-400">Actions</th>
                </tr>
              </thead>
              <tbody>
                {bots.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-zinc-500">
                      No clients yet. Add one to get started.
                    </td>
                  </tr>
                ) : (
                  bots.map((bot) => (
                    <tr
                      key={bot.id}
                      className="border-b border-zinc-800/80 hover:bg-zinc-900/50"
                    >
                      <td className="py-3 px-4 font-medium">
                        {bot.name || '—'}
                      </td>
                      <td className="py-3 px-4 text-zinc-300">{bot.email}</td>
                      <td className="py-3 px-4">
                        <Badge variant={statusVariant(bot.status)}>{bot.status}</Badge>
                      </td>
                      <td className="py-3 px-4 font-mono text-zinc-300">
                        {getMinPrice(bot.filters ?? {})}
                      </td>
                      <td className="py-3 px-4 font-mono text-zinc-300">
                        {getMinHours(bot.filters ?? {})}
                      </td>
                      <td className="py-3 px-4 font-mono text-zinc-300">
                        {getMinGap(bot.filters ?? {})}
                      </td>
                      <td className="py-3 px-4 text-zinc-500 text-xs">
                        {formatDate(bot.last_seen)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditBot(bot)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleToggle(bot)}
                            className={
                              bot.status === 'RUNNING'
                                ? 'text-red-400 hover:text-red-300'
                                : 'text-emerald-400 hover:text-emerald-300'
                            }
                          >
                            {bot.status === 'RUNNING' ? 'OFF' : 'ON'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(bot)}
                            className="text-zinc-500 hover:text-red-400"
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <AddClientDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSuccess={fetchBots}
      />

      {editBot && (
        <EditClientDialog
          bot={editBot}
          open={!!editBot}
          onOpenChange={(open) => !open && setEditBot(null)}
          onSuccess={handleEditSuccess}
        />
      )}

      {/* Notification: match(s) — "Pour le compte de X, on aurait pris cette offre" */}
      {botsWithMatch.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-emerald-800/80 bg-zinc-900/95 backdrop-blur px-4 py-3">
          <div className="max-w-4xl mx-auto space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-emerald-400/90 uppercase tracking-wider">
                Match test (simulation)
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="text-zinc-500 hover:text-zinc-300 text-xs"
                onClick={dismissAllMatches}
              >
                Tout effacer
              </Button>
            </div>
            {botsWithMatch.slice(0, 5).map(({ bot, last_match, key }) => (
              <div
                key={key}
                className="text-sm text-zinc-200 flex flex-wrap items-center gap-x-2 gap-y-1 group"
              >
                <span className="flex-1 min-w-0">
                  Pour le compte de <strong className="text-zinc-100">{bot.name || bot.email}</strong>, on aurait pris cette offre
                  <span className="text-zinc-500"> — </span>
                  <span className="text-zinc-400">
                    {formatMatchTime(last_match.at)}
                    {last_match.pickup_at && (
                      <span className="ml-2 text-zinc-500">
                        (course à {formatMatchTime(last_match.pickup_at)})
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-emerald-400 ml-1">
                    {typeof last_match.price === 'number'
                      ? `${last_match.price} €`
                      : `${String(last_match.price)} €`}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 h-7 w-7 p-0"
                  onClick={() => dismissMatch(key)}
                  title="Fermer"
                >
                  ×
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
