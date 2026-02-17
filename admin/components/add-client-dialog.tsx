'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { addClient } from '@/app/actions/bots';

interface AddClientDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

const VEHICLE_OPTIONS = ['business', 'first', 'economy', 'minivan', 'minibus', 'sprinter'];

export function AddClientDialog({ open, onOpenChange, onSuccess }: AddClientDialogProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [minPrice, setMinPrice] = useState('50');
  const [minHoursFromNow, setMinHoursFromNow] = useState('');
  const [vehicleTypes, setVehicleTypes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
      const result = await addClient({
        name: name.trim(),
        email: email.trim(),
        password,
        minPrice: parseFloat(minPrice) || 0,
        minHoursFromNow: minHoursFromNow ? parseInt(minHoursFromNow, 10) : undefined,
        vehicleTypes,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setName('');
      setEmail('');
      setPassword('');
      setMinPrice('50');
      setMinHoursFromNow('');
      setVehicleTypes([]);
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
          <DialogTitle>Add Client</DialogTitle>
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
              placeholder="partner@example.com"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">Blacklane Password</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
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
              {loading ? 'Adding…' : 'Add Client'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
