'use client';

import React from 'react';

interface ComingSoonCardProps {
  label?: string;
}

export function ComingSoonCard({ label }: ComingSoonCardProps) {
  return (
    <div className="glass-card p-8 rounded-2xl relative overflow-hidden flex flex-col items-center justify-center text-center border border-white/5 bg-white/[0.01]">
      <div className="mb-4 flex items-center justify-center">
        <div className="w-16 h-16 rounded-full bg-[#141414] border border-[#262626] flex items-center justify-center shadow-[0_0_30px_rgba(15,23,42,0.8)]">
          <span className="material-symbols-outlined text-4xl text-slate-500">lock</span>
        </div>
      </div>
      <p className="text-sm font-semibold tracking-widest uppercase text-slate-400">
        Coming soon
      </p>
      {label && (
        <p className="mt-2 text-xs text-slate-500 max-w-xs">
          {label}
        </p>
      )}
    </div>
  );
}

