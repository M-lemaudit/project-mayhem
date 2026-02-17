'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { updateClient } from '@/app/actions/bots';
import type { BotRow } from '@/lib/supabase';

const VEHICLE_OPTIONS = ['business', 'first', 'economy', 'minivan', 'minibus', 'sprinter'];

interface EditClientDialogProps {
  bot: BotRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function EditClientDialog({
  bot,
  open,
  onOpenChange,
  onSuccess,
}: EditClientDialogProps) {
  const filters = (bot.filters ?? {}) as Record<string, unknown>;
  const [name, setName] = useState(bot.name ?? '');
  const [email, setEmail] = useState(bot.email ?? '');
  const [password, setPassword] = useState('');
  const [minPrice, setMinPrice] = useState(
    String(typeof filters.minPrice === 'number' ? filters.minPrice : 50)
  );
  const [minHoursFromNow, setMinHoursFromNow] = useState(
    typeof filters.minHoursFromNow === 'number' ? String(filters.minHoursFromNow) : ''
  );
  const [vehicleTypes, setVehicleTypes] = useState<string[]>(
    Array.isArray(filters.allowedVehicleTypes) ? (filters.allowedVehicleTypes as string[]) : []
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setName(bot.name ?? '');
      setEmail(bot.email ?? '');
      setPassword('');
      const f = (bot.filters ?? {}) as Record<string, unknown>;
      setMinPrice(String(typeof f.minPrice === 'number' ? f.minPrice : 50));
      setMinHoursFromNow(
        typeof f.minHoursFromNow === 'number' ? String(f.minHoursFromNow) : ''
      );
      setVehicleTypes(
        Array.isArray(f.allowedVehicleTypes) ? (f.allowedVehicleTypes as string[]) : []
      );
      setError('');
    }
  }, [open, bot]);

  const toggleVehicle = (v: string) => {
    setVehicleTypes((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const updates: { name?: string; email?: string; password?: string; minPrice?: number; minHoursFromNow?: number; vehicleTypes?: string[] } = {
        name: name.trim() || undefined,
        email: email.trim() || undefined,
        minPrice: parseFloat(minPrice) || undefined,
        minHoursFromNow: minHoursFromNow ? parseInt(minHoursFromNow, 10) : undefined,
        vehicleTypes,
      };
      if (password) updates.password = password;
      const result = await updateClient(bot.id, updates);
      if (result.error) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Client</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">Client Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Transport Durand"
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">Blacklane Email</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Blacklane Password <span className="text-zinc-600">(leave blank to keep)</span>
            </label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">Min Price (€)</label>
            <Input
              type="number"
              min={0}
              step={0.5}
              value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Min hours before pickup
            </label>
            <Input
              type="number"
              min={0}
              placeholder="e.g. 36"
              value={minHoursFromNow}
              onChange={(e) => setMinHoursFromNow(e.target.value)}
            />
            <p className="text-xs text-zinc-500 mt-1">
              Only accept courses starting at least this many hours from now. Leave empty for no filter.
            </p>
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">Vehicle Types</label>
            <div className="flex flex-wrap gap-2">
              {VEHICLE_OPTIONS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => toggleVehicle(v)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    vehicleTypes.includes(v)
                      ? 'bg-emerald-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
