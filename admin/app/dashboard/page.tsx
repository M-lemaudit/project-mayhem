'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, type BotRow } from '@/lib/supabase';
import { addClient } from '@/app/actions/bots';

interface NetworkAccount {
  id: string;
  providerLabel: string;
  providerVariant: 'blacklane' | 'sixt' | 'w' | 'generic';
  statusLabel: 'Active' | 'Standby';
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
    bot.status === 'RUNNING' ? 'Active' : 'Standby';

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
      console.error(err);
    } finally {
      setIsAdding(false);
    }
  };

  const activeBots = bots.filter((b) => b.status === 'RUNNING').length;
  const accounts: NetworkAccount[] = bots.map(mapBotToAccount);

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#0a0a0a] text-slate-400">
        <p>Loading executive dashboard…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-slate-100 font-[Inter,sans-serif]">
      {/* Top Header (from Stitch design) */}
      <header className="border-b border-neutral-800 bg-[#0a0a0a]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1440px] mx-auto px-6 h-20 flex items-center justify-between">
          {/* Brand + global status */}
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[#d4af35] text-3xl">
                directions_car
              </span>
              <h1 className="text-xl font-light tracking-luxury uppercase text-slate-100">
                Chauffeur <span className="font-bold">Elite</span>
              </h1>
            </div>
            <div className="h-6 w-px bg-neutral-800" />
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#d4af35]/5 border border-[#d4af35]/20">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#d4af35] opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#d4af35]" />
              </span>
              <span className="text-[10px] font-bold tracking-widest uppercase text-[#d4af35]">
                Global Bot Online
              </span>
            </div>
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
              <button className="w-10 h-10 flex items-center justify-center rounded-lg border border-[#262626] hover:bg-[#262626] transition-colors text-slate-400 hover:text-[#d4af35]">
                <span className="material-symbols-outlined">notifications</span>
              </button>
              <button
                className="w-10 h-10 flex items-center justify-center rounded-lg border border-[#262626] hover:bg-[#262626] transition-colors text-slate-400 hover:text-[#d4af35]"
                onClick={handleLogout}
              >
                <span className="material-symbols-outlined">settings</span>
              </button>
              <div className="h-8 w-px bg-[#262626] mx-2" />
              <div className="flex items-center gap-3 pl-2">
                <div className="text-right hidden sm:block">
                  <p className="text-xs font-bold text-slate-100">Julian Voss</p>
                  <p className="text-[10px] text-[#d4af35]/80 tracking-tight">Premium Tier</p>
                </div>
                <div className="w-10 h-10 rounded-full border border-[#d4af35]/30 p-0.5 overflow-hidden">
                  {/* Static avatar from Stitch design */}
                  <img
                    className="w-full h-full rounded-full object-cover"
                    src="https://lh3.googleusercontent.com/aida-public/AB6AXuBdueTnP0AvdQ1MAO-X072TlNMJGI3fmLS0kWTDNjoEfIJZED3_ipBFr2RF_6JfuzSeLzsiF9RZt4qa9Tb5OkHdAIX07u2zkB24DHn9b-QilHSmBdlA8_TfE7fEVHXW6GMckRjxfKz3z3OVBpad7z_bvbS59FR-Ahbnv83hd1cThmtvOkeN89whFK1gkv39sBaODtZDW38hQxh0kpFDUP0-ioZxjl_oTVQCHuFuRT4jkYBd_JafYQKbx3lAXVKXl8nyaaAnJT2oWzOx"
                    alt="Chauffeur profile"
                  />
                </div>
              </div>
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
            <button className="px-5 py-2.5 bg-[#141414] border border-[#262626] text-slate-300 rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-[#262626] transition-colors">
              <span className="material-symbols-outlined text-lg">calendar_today</span>
              Last 30 Days
            </button>
            <button className="px-5 py-2.5 bg-[#d4af35] text-black rounded-lg text-sm font-bold flex items-center gap-2 hover:brightness-110 transition-all shadow-lg shadow-[#d4af35]/10">
              <span className="material-symbols-outlined text-lg">download</span>
              Export Report
            </button>
          </div>
        </div>

        {/* Aggregate metrics (still static for now) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <div className="glass-card p-8 rounded-2xl relative overflow-hidden group transition-all duration-500">
            <p className="text-[10px] font-bold tracking-ultra-wide uppercase text-slate-500 mb-6">
              Total Revenue
            </p>
            <div className="flex items-baseline justify-between relative z-10">
              <h3 className="text-4xl font-light text-slate-100">$128,450.00</h3>
              <div className="text-emerald-500 text-xs font-medium flex items-center gap-1 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                <span className="material-symbols-outlined text-[14px]">trending_up</span>
                12.5%
              </div>
            </div>
          </div>
          <div className="glass-card p-8 rounded-2xl relative overflow-hidden group transition-all duration-500">
            <p className="text-[10px] font-bold tracking-ultra-wide uppercase text-slate-500 mb-6">
              Total Sniped Rides
            </p>
            <div className="flex items-baseline justify-between relative z-10">
              <h3 className="text-4xl font-light text-slate-100">1,242</h3>
              <div className="text-emerald-500 text-xs font-medium flex items-center gap-1 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                <span className="material-symbols-outlined text-[14px]">trending_up</span>
                4.2%
              </div>
            </div>
            <p className="mt-8 text-[11px] text-slate-500 flex items-center gap-2">
              <span className="w-1 h-1 rounded-full bg-[#d4af35]" />
              Avg. snipe:
              <span className="text-slate-300 font-medium">0.4s</span>
            </p>
          </div>
          <div className="glass-card p-8 rounded-2xl relative overflow-hidden group transition-all duration-500">
            <p className="text-[10px] font-bold tracking-ultra-wide uppercase text-slate-500 mb-6">
              Success Rate
            </p>
            <div className="flex items-baseline justify-between relative z-10">
              <h3 className="text-4xl font-light text-slate-100">98.2%</h3>
              <div className="text-emerald-500 text-xs font-medium flex items-center gap-1 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                <span className="material-symbols-outlined text-[14px]">trending_up</span>
                0.8%
              </div>
            </div>
          </div>
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
                className="glass-card p-6 rounded-2xl transition-all duration-300 cursor-pointer group"
                onClick={() => router.push(`/accounts/${account.id}`)}
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

                  {/* Status pill */}
                  {account.statusLabel === 'Active' ? (
                    <span className="px-2 py-0.5 bg-emerald-500/5 text-emerald-500 text-[9px] font-bold rounded-full uppercase tracking-widest border border-emerald-500/10">
                      Active
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 bg-slate-500/10 text-slate-400 text-[9px] font-bold rounded-full uppercase tracking-widest border border-white/10">
                      Standby
                    </span>
                  )}
                </div>

                <h4 className="text-base font-semibold text-slate-100 group-hover:text-[#d4af35] transition-colors">
                  {account.title}
                </h4>
                <p className="text-xs text-slate-500 mt-1 mb-6">{account.subtitle}</p>

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
