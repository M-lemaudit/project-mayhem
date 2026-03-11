'use client';

interface FullPageLoaderProps {
  message?: string;
}

export function FullPageLoader({ message }: FullPageLoaderProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] text-slate-400">
      <div className="flex flex-col items-center gap-4">
        <div className="w-10 h-10 rounded-full border-2 border-[#262626] border-t-[#d4af35] border-l-[#d4af35] animate-spin" />
        {message && <p className="text-sm font-medium">{message}</p>}
      </div>
    </div>
  );
}

