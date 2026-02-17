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

export default function DashboardPage() {
  const router = useRouter();
  const [bots, setBots] = useState<BotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [editBot, setEditBot] = useState<BotRow | null>(null);

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

  useEffect(() => {
    fetchBots().finally(() => setLoading(false));
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

  if (loading) {
    return (
      <main className="min-h-screen p-6 flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Sniper Admin HQ</h1>
        <Button variant="outline" size="sm" onClick={handleLogout}>
          Logout
        </Button>
      </header>

      <div className="p-6 space-y-6">
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
                  <th className="text-left py-3 px-4 font-medium text-zinc-400">Last Seen</th>
                  <th className="text-right py-3 px-4 font-medium text-zinc-400">Actions</th>
                </tr>
              </thead>
              <tbody>
                {bots.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-zinc-500">
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
    </main>
  );
}
