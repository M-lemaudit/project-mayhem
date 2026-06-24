'use client';

interface FullPageLoaderProps {
  message?: string;
}

export function FullPageLoader({ message }: FullPageLoaderProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-paper text-muted">
      <div className="flex flex-col items-center gap-4">
        <div className="h-8 w-8 rounded-full border-2 border-hairline border-t-accent animate-spin" />
        {message && <p className="text-sm">{message}</p>}
      </div>
    </div>
  );
}
