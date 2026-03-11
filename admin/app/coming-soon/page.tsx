'use client';

import { ComingSoonCard } from '@/components/coming-soon-card';
import Link from 'next/link';

export default function ComingSoonPage() {
  return (
    <main className="min-h-screen bg-[#0a0a0a] text-slate-100 font-[Inter,sans-serif] flex flex-col">
      <header className="border-b border-neutral-800 bg-[#0a0a0a]/80 backdrop-blur-md">
        <div className="max-w-[1440px] mx-auto px-6 h-16 flex items-center justify-between">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 text-xs text-slate-500 hover:text-slate-200 transition-colors"
          >
            <span className="material-symbols-outlined text-base">arrow_back</span>
            Back to dashboard
          </Link>
          <span className="text-[10px] font-bold tracking-[0.25em] uppercase text-slate-500">
            Preview Features
          </span>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center px-4">
        <div className="max-w-md w-full space-y-8 flex flex-col items-center">
          <ComingSoonCard />
          <p className="text-xs text-slate-500 text-center max-w-sm">
            This area of the dashboard is still under construction. Your future analytics and
            controls will appear here once they are ready.
          </p>
        </div>
      </div>
    </main>
  );
}

