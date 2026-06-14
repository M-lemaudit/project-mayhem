'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, type BotRow } from '@/lib/supabase';
import { addClient, deleteClient } from '@/app/actions/bots';
import { LiveSnipeLog } from '@/components/live-snipe-log';
import { ComingSoonCard } from '@/components/coming-soon-card';
import { FullPageLoader } from '@/components/full-page-loader';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface NetworkAccount {
  id: string;
  providerLabel: string;
  providerVariant: 'blacklane' | 'sixt' | 'w' | 'generic';
  statusLabel: 'Active' | 'Standby' | 'Error';
  title: string;
  subtitle: string;
  revenueLabel: string;
}

function mapBotToAccount(bot: BotRow): NetworkAccount {
  const name = bot.name || bot.email;
  const emailDomain = bot.email.split('@')[1] ?? '';
  const domain = emailDomain.toLowerCase();

  let providerVariant: NetworkAccount['providerVariant'] = 'generic';
  let providerLabel = 'ACCOUNT';

  if (domain.includes('blacklane')) {
    providerVariant = 'blacklane';
    providerLabel = 'BLACKLANE';
  } else if (domain.includes('sixt')) {
    providerVariant = 'sixt';
    providerLabel = 'SIXT';
  } else if (domain.includes('wheely') || domain === 'w') {
    providerVariant = 'w';
    providerLabel = 'W';
  } else if (domain) {
    providerLabel = domain.split('.')[0]?.toUpperCase() || 'ACCOUNT';
  }

  const statusLabel: NetworkAccount['statusLabel'] =
    bot.status === 'RUNNING'
      ? 'Active'
      : bot.status === 'ERROR_AUTH'
      ? 'Error'
      : 'Standby';

  return {
    id: bot.id,
    providerLabel,
    providerVariant,
    statusLabel,
    title: name,
    subtitle: 'Premium fleet account',
    revenueLabel: '—',
  };
}

export default function DashboardPage() {
  const router = useRouter();
  const [bots, setBots] = useState<BotRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Add Account Modal states
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [botToDelete, setBotToDelete] = useState<NetworkAccount | null>(null);

  const fetchBots = async () => {
    // Data isolation: only ever load the bots owned by the signed-in user.
    // RLS is currently permissive, so this client-side scope is what prevents
    // one account from seeing another account's bots in the dashboard.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push('/login');
      return;
    }
    const { data, error } = await supabase
      .from('bots')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('Failed to fetch bots', {
        errorMessage: error.message,
        errorStack: 'stack' in error && typeof error.stack === 'string' ? error.stack : undefined,
      });
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

  const confirmDeleteBot = (account: NetworkAccount) => {
    setBotToDelete(account);
  };

  const handleConfirmDelete = async () => {
    if (!botToDelete) return;
    const result = await deleteClient(botToDelete.id);
    if ((result as any)?.error) {
      alert('Failed to delete account: ' + (result as any).error);
      return;
    }

    // Optimistic update + full refresh from Supabase
    setBots((prev) => prev.filter((b) => b.id !== botToDelete.id));
    setBotToDelete(null);
    fetchBots();
  };

  const handleLogout = async () => {
    const { createClient } = await import('@/lib/supabase/client');
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const handleCreateAccount = async () => {
    if (!newEmail || !newPassword) {
      alert('Email and Password are required');
      return;
    }

    setIsAdding(true);
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

      if (result.error) {
        alert('Failed to create account: ' + result.error);
      } else if (result.data) {
        router.push(`/accounts/${result.data.id}`);
      }
    } catch (err) {
      alert('An error occurred');
      console.error('Dashboard action failed', {
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      });
    } finally {
      setIsAdding(false);
    }
  };

  const activeBots = bots.filter((b) => b.status === 'RUNNING').length;
  const accounts: NetworkAccount[] = bots.map(mapBotToAccount);
  const botsById = useMemo(
    () =>
      bots.reduce<Record<string, BotRow>>((acc, bot) => {
        acc[bot.id] = bot;
        return acc;
      }, {}),
    [bots]
  );

  if (loading) {
    return <FullPageLoader message="Loading executive dashboard…" />;
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-slate-100 font-[Inter,sans-serif]">
      {/* Top Header (from Stitch design) */}
      <header className="border-b border-neutral-800 bg-[#0a0a0a]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1440px] mx-auto px-6 h-20 flex items-center justify-between">
          {/* Brand */}
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[#d4af35] text-3xl">
              directions_car
            </span>
            <h1 className="text-xl font-light tracking-luxury uppercase text-slate-100">
              Chauffeur <span className="font-bold">Elite</span>
            </h1>
          </div>
          {/* Search + user */}
          <div className="flex items-center gap-8">
            <div className="relative w-64 group">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xl group-focus-within:text-[#d4af35] transition-colors">
                search
              </span>
              <input
                type="text"
                placeholder="Search accounts..."
                className="w-full bg-[#141414] border border-[#262626] rounded-lg pl-10 pr-4 py-2 text-sm focus:ring-1 focus:ring-[#d4af35] focus:border-[#d4af35] transition-all placeholder:text-slate-600"
              />
            </div>
            <div className="flex items-center gap-4">
              <button
                className="w-10 h-10 flex items-center justify-center rounded-lg border border-[#262626] bg-[#141414] text-slate-600 cursor-not-allowed opacity-60"
                disabled
              >
                <span className="material-symbols-outlined">notifications</span>
              </button>
              <button
                className="px-4 py-2 rounded-lg border border-[#262626] bg-[#141414] text-xs font-semibold text-slate-300 hover:bg-[#262626] hover:text-[#d4af35] transition-colors"
                onClick={handleLogout}
              >
                Log out
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1440px] mx-auto w-full p-8 flex-1 mesh-gradient">
        {/* Header text + static metrics copied from Stitch */}
        <div className="mb-10 flex items-end justify-between">
          <div>
            <h2 className="text-4xl font-light tracking-tight text-slate-100">
              Executive Dashboard
            </h2>
            <p className="text-slate-500 mt-1">
              Real-time performance across your global fleet networks.
            </p>
          </div>
          <div className="flex gap-3">
            <button
              className="px-5 py-2.5 bg-[#141414] border border-[#262626] text-slate-500 rounded-lg text-sm font-medium flex items-center gap-2 cursor-not-allowed opacity-60"
              disabled
            >
              <span className="material-symbols-outlined text-lg">calendar_today</span>
              Last 30 Days
            </button>
            <button
              className="px-5 py-2.5 bg-[#262626] text-slate-500 rounded-lg text-sm font-bold flex items-center gap-2 cursor-not-allowed opacity-60"
              disabled
            >
              <span className="material-symbols-outlined text-lg">download</span>
              Export Report
            </button>
          </div>
        </div>

        {/* Live Snipe Log (global) */}
        <div className="mb-12">
          <LiveSnipeLog mode="global" botsById={botsById} />
        </div>

        {/* Network Accounts (dynamic) */}
        <section className="space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-light tracking-luxury uppercase text-slate-400 tracking-ultra-wide">
              Network Accounts
            </h3>
            <div className="flex gap-2">
              <button className="p-2 text-slate-500 hover:text-slate-100">
                <span className="material-symbols-outlined">grid_view</span>
              </button>
              <button className="p-2 text-slate-500 hover:text-slate-100">
                <span className="material-symbols-outlined">list</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {accounts.map((account) => (
              <div
                key={account.id}
                className="glass-card p-6 rounded-2xl transition-all duration-300 group"
              >
                <div className="flex justify-between items-start mb-6">
                  {/* Provider logo variant */}
                  {account.providerVariant === 'blacklane' && (
                    <div className="w-10 h-10 rounded-lg bg-black border border-white/10 flex items-center justify-center overflow-hidden">
                      <div className="bg-white text-black font-black text-[8px] p-0.5">
                        {account.providerLabel}
                      </div>
                    </div>
                  )}
                  {account.providerVariant === 'sixt' && (
                    <div className="w-10 h-10 rounded-lg bg-[#FF5F00] flex items-center justify-center">
                      <span className="text-white font-black text-[9px]">
                        {account.providerLabel}
                      </span>
                    </div>
                  )}
                  {account.providerVariant === 'w' && (
                    <div className="w-10 h-10 rounded-lg bg-black border border-white/10 flex items-center justify-center">
                      <span className="text-slate-100 font-serif italic text-base">
                        {account.providerLabel}
                      </span>
                    </div>
                  )}
                  {account.providerVariant === 'generic' && (
                    <div className="w-10 h-10 rounded-lg bg-black border border-white/10 flex items-center justify-center overflow-hidden">
                      <div className="bg-white text-black font-black text-[8px] px-1 py-0.5">
                        {account.providerLabel}
                      </div>
                    </div>
                  )}

                  {/* Actions: status pill + delete */}
                  <div className="flex items-center gap-2">
                    {account.statusLabel === 'Active' ? (
                      <span className="px-2 py-0.5 bg-emerald-500/5 text-emerald-500 text-[9px] font-bold rounded-full uppercase tracking-widest border border-emerald-500/10">
                        Active
                      </span>
                    ) : account.statusLabel === 'Error' ? (
                      <span className="px-2 py-0.5 bg-rose-500/10 text-rose-400 text-[9px] font-bold rounded-full uppercase tracking-widest border border-rose-500/30">
                        Error
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 bg-slate-500/10 text-slate-400 text-[9px] font-bold rounded-full uppercase tracking-widest border border-white/10">
                        Standby
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => confirmDeleteBot(account)}
                      className="ml-1 flex items-center justify-center w-7 h-7 rounded-full border border-rose-500/40 bg-rose-500/10 text-rose-400 hover:bg-rose-500 hover:text-white transition-colors text-[16px]"
                      aria-label="Delete account"
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => router.push(`/accounts/${account.id}`)}
                  className="text-left w-full"
                >
                  <h4 className="text-base font-semibold text-slate-100 group-hover:text-[#d4af35] transition-colors">
                    {account.title}
                  </h4>
                  <p className="text-xs text-slate-500 mt-1 mb-6">{account.subtitle}</p>
                </button>

                <div className="flex items-center justify-between pt-4 border-t border-white/5">
                  <div>
                    <p className="text-[9px] uppercase tracking-ultra-wide text-slate-600 mb-1">
                      Current Revenue
                    </p>
                    <p className="text-sm font-medium text-slate-200">
                      {account.revenueLabel}
                    </p>
                  </div>
                  <span className="material-symbols-outlined text-slate-600 group-hover:text-[#d4af35] group-hover:translate-x-1 transition-all">
                    arrow_forward
                  </span>
                </div>
              </div>
            ))}

            {/* Add Account card (static, from design) */}
            <button
              type="button"
              className="border-2 border-dashed border-white/10 rounded-2xl flex flex-col items-center justify-center p-8 hover:border-[#d4af35]/40 hover:bg-[#d4af35]/5 transition-all duration-500 cursor-pointer group"
              onClick={() => setIsAddModalOpen(true)}
            >
              <div className="w-12 h-12 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mb-4 group-hover:bg-[#d4af35] group-hover:scale-110 transition-all duration-500">
                <span className="material-symbols-outlined text-slate-400 group-hover:text-black font-light">
                  add
                </span>
              </div>
              <p className="text-sm font-semibold text-slate-400 group-hover:text-slate-100 transition-colors uppercase tracking-widest">
                Add Account
              </p>
              <p className="text-[10px] text-slate-600 mt-2 font-medium">Connect via API</p>
            </button>
          </div>
        </section>

      </main>

      {/* Delete account confirmation modal */}
      <Dialog open={!!botToDelete} onOpenChange={(open) => !open && setBotToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete account</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-zinc-300">
            Are you sure you want to delete{' '}
            <span className="font-semibold text-white">
              {botToDelete?.title || botToDelete?.providerLabel}
            </span>{' '}
            and all of its settings? This action cannot be undone.
          </p>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setBotToDelete(null)}
              className="px-4 py-2 rounded-md border border-zinc-600 bg-zinc-900 text-sm text-zinc-200 hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              className="px-4 py-2 rounded-md bg-rose-600 text-sm font-semibold text-white hover:bg-rose-500 transition-colors"
            >
              Delete account
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Account Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-300">
          {/* Backdrop */}
          <div 
            className="absolute inset-0 bg-black/90 backdrop-blur-xl"
            onClick={() => setIsAddModalOpen(false)}
          ></div>
          
          {/* Modal Content */}
          <div className="relative w-full max-w-lg bg-[#0f0f0f] border border-neutral-800 rounded-3xl shadow-[0_0_50px_rgba(0,0,0,0.5)] overflow-hidden animate-in zoom-in-95 duration-300">
            <div className="p-8 border-b border-neutral-900 bg-gradient-to-b from-[#141414] to-transparent">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <div className="size-10 rounded-xl bg-[#d4af35]/10 border border-[#d4af35]/20 flex items-center justify-center">
                    <span className="material-symbols-outlined text-[#d4af35]">person_add</span>
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-white tracking-tight">Add New Account</h3>
                    <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Configure fleet connection</p>
                  </div>
                </div>
                <button 
                  onClick={() => setIsAddModalOpen(false)}
                  className="size-10 flex items-center justify-center rounded-xl hover:bg-neutral-800 text-slate-500 hover:text-white transition-all"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            </div>
            
            <div className="p-8 space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1">Account Label</label>
                <div className="relative group">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-600 text-xl group-focus-within:text-[#d4af35] transition-colors">badge</span>
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="w-full bg-[#141414] border border-[#262626] rounded-xl pl-12 pr-4 py-4 text-white outline-none focus:border-[#d4af35] focus:ring-1 focus:ring-[#d4af35] transition-all placeholder:text-slate-700"
                    placeholder="e.g. London Elite Fleet"
                  />
                </div>
              </div>
              
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1">Blacklane Email</label>
                <div className="relative group">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-600 text-xl group-focus-within:text-[#d4af35] transition-colors">mail</span>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => newEmail !== e.target.value && setNewEmail(e.target.value)}
                    className="w-full bg-[#141414] border border-[#262626] rounded-xl pl-12 pr-4 py-4 text-white outline-none focus:border-[#d4af35] focus:ring-1 focus:ring-[#d4af35] transition-all placeholder:text-slate-700"
                    placeholder="connect@blacklane.com"
                  />
                </div>
              </div>
              
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1">Bot Access Password</label>
                <div className="relative group">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-600 text-xl group-focus-within:text-[#d4af35] transition-colors">lock</span>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full bg-[#141414] border border-[#262626] rounded-xl pl-12 pr-4 py-4 text-white outline-none focus:border-[#d4af35] focus:ring-1 focus:ring-[#d4af35] transition-all placeholder:text-slate-700"
                    placeholder="••••••••••••"
                  />
                </div>
              </div>

              <div className="pt-4 flex gap-4">
                <button
                  onClick={() => setIsAddModalOpen(false)}
                  className="flex-1 px-6 py-4 border border-[#262626] text-slate-400 font-bold rounded-xl hover:bg-neutral-800 hover:text-white transition-all uppercase tracking-widest text-xs"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateAccount}
                  disabled={isAdding || !newEmail || !newPassword}
                  className="flex-[2] px-6 py-4 bg-gradient-to-br from-[#e5c76b] to-[#b8952b] text-black font-black rounded-xl shadow-xl shadow-[#d4af35]/10 hover:brightness-110 active:scale-[0.98] transition-all flex items-center justify-center gap-3 disabled:opacity-50 disabled:grayscale uppercase tracking-widest text-xs"
                >
                  {isAdding ? (
                    <>
                      <span className="material-symbols-outlined animate-spin text-lg">sync</span>
                      Connecting...
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-xl">rocket_launch</span>
                      Launch Account
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
