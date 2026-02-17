'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

const Dialog = ({ open, onOpenChange, children }: DialogProps) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div
        className="fixed inset-0 bg-black/70"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        {children}
      </div>
    </div>
  );
};

const DialogContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { onClose?: () => void }
>(({ className, children, onClose, ...props }, ref) => (
  <div
    ref={ref}
    role="dialog"
    aria-modal="true"
    className={cn(
      'relative z-50 w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-2xl',
      className
    )}
    onClick={(e) => e.stopPropagation()}
    {...props}
  >
    {children}
  </div>
));

DialogContent.displayName = 'DialogContent';

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('mb-4', className)} {...props} />
);

const DialogTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h2 className={cn('text-lg font-semibold text-zinc-100', className)} {...props} />
);

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('mt-6 flex justify-end gap-2', className)} {...props} />
);

export { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter };
