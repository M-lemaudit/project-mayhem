'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Triangle, LayoutDashboard, Receipt, LogOut, Menu, X } from 'lucide-react';
import { supabase, type BotRow } from '@/lib/supabase';
import { BRAND } from '@/lib/brand';
import { StatusDot } from '@/components/status-dot';
import { cn } from '@/lib/utils';

type FleetBot = Pick<BotRow, 'id' | 'name' | 'email' | 'status'>;

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/billing', label: 'Billing', icon: Receipt },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [fleet, setFleet] = useState<FleetBot[]>([]);
  const [email, setEmail] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      if (active) setEmail(user.email ?? '');
      const { data } = await supabase
        .from('bots')
        .select('id, name, email, status')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (active && data) setFleet(data as FleetBot[]);
    }
    load();
    const channel = supabase
      .channel('app-shell-fleet')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bots' }, load)
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, []);

  // Close the mobile drawer on navigation.
  useEffect(() => setMobileOpen(false), [pathname]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const nav = (
    <nav className="flex h-full flex-col gap-1">
      <Link href="/dashboard" className="mb-8 flex items-center gap-2 px-3">
        <Triangle className="h-4 w-4 text-accent" strokeWidth={1.5} fill="currentColor" />
        <span className="font-display text-xl text-ink">{BRAND.name}</span>
      </Link>

      {NAV.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
              active ? 'bg-accent/8 text-accent font-medium' : 'text-muted hover:text-ink hover:bg-paper'
            )}
          >
            <Icon className="h-4 w-4" strokeWidth={1.75} />
            {label}
          </Link>
        );
      })}

      <p className="eyebrow mt-8 mb-2 px-3">Fleet</p>
      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
        {fleet.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted/70">No bots yet.</p>
        ) : (
          fleet.map((bot) => {
            const active = pathname === `/accounts/${bot.id}`;
            return (
              <Link
                key={bot.id}
                href={`/accounts/${bot.id}`}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                  active ? 'bg-accent/8 text-accent font-medium' : 'text-muted hover:text-ink hover:bg-paper'
                )}
              >
                <StatusDot status={bot.status} />
                <span className="truncate">{bot.name || bot.email}</span>
              </Link>
            );
          })
        )}
      </div>

      <div className="mt-4 border-t border-hairline pt-4">
        {email && <p className="mb-2 truncate px-3 text-xs text-muted/70">{email}</p>}
        <button
          type="button"
          onClick={handleLogout}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:text-ink hover:bg-paper"
        >
          <LogOut className="h-4 w-4" strokeWidth={1.75} />
          Log out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-paper text-ink">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-hairline bg-surface px-4 py-6 lg:flex">
        {nav}
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-hairline bg-surface/90 px-4 py-3 backdrop-blur lg:hidden">
        <Link href="/dashboard" className="flex items-center gap-2">
          <Triangle className="h-4 w-4 text-accent" strokeWidth={1.5} fill="currentColor" />
          <span className="font-display text-lg">{BRAND.name}</span>
        </Link>
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="rounded-lg p-1.5 text-muted hover:text-ink"
        >
          <Menu className="h-5 w-5" />
        </button>
      </header>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink/30 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <div className="rise absolute inset-y-0 left-0 w-72 border-r border-hairline bg-surface px-4 py-6">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
              className="absolute right-3 top-3 rounded-lg p-1.5 text-muted hover:text-ink"
            >
              <X className="h-5 w-5" />
            </button>
            {nav}
          </div>
        </div>
      )}

      <main className="lg:pl-64">
        <div className="mx-auto w-full max-w-6xl px-5 py-8 md:px-10 md:py-12">{children}</div>
      </main>
    </div>
  );
}
