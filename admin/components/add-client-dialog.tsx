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

const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'America/New York' },
  { value: 'Europe/Paris', label: 'Europe/Paris' },
  { value: 'Europe/London', label: 'Europe/London' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai' },
];

const LOCALE_OPTIONS = [
  { value: 'en-US', label: 'en-US' },
  { value: 'fr-FR', label: 'fr-FR' },
  { value: 'en-GB', label: 'en-GB' },
  { value: 'de-DE', label: 'de-DE' },
];

const DEFAULT_LAT = '25.7617';
const DEFAULT_LONG = '-80.1918';

export function AddClientDialog({ open, onOpenChange, onSuccess }: AddClientDialogProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [minPrice, setMinPrice] = useState('40');
  const [minHoursFromNow, setMinHoursFromNow] = useState('');
  const [vehicleTypes, setVehicleTypes] = useState<string[]>([]);
  const [timezone, setTimezone] = useState('America/New_York');
  const [locale, setLocale] = useState('en-US');
  const [latitude, setLatitude] = useState(DEFAULT_LAT);
  const [longitude, setLongitude] = useState(DEFAULT_LONG);
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
        timezone: timezone.trim(),
        locale: locale.trim(),
        latitude: parseFloat(latitude) ?? 25.7617,
        longitude: parseFloat(longitude) ?? -80.1918,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setName('');
      setEmail('');
      setPassword('');
      setMinPrice('40');
      setMinHoursFromNow('');
      setVehicleTypes([]);
      setTimezone('America/New_York');
      setLocale('en-US');
      setLatitude(DEFAULT_LAT);
      setLongitude(DEFAULT_LONG);
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
        <form onSubmit={handleSubmit} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto">
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

          <details className="rounded-lg border border-zinc-700 bg-zinc-900/50 overflow-hidden">
            <summary className="px-4 py-3 text-sm font-medium text-zinc-300 cursor-pointer hover:bg-zinc-800/50">
              Stealth Settings
            </summary>
            <div className="px-4 pb-4 pt-1 space-y-4 border-t border-zinc-700">
              <div>
                <label className="block text-sm text-zinc-400 mb-1.5">Timezone</label>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  {TIMEZONE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1.5">Locale</label>
                <select
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  {LOCALE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1.5">Location (Latitude / Longitude)</label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    step="any"
                    value={latitude}
                    onChange={(e) => setLatitude(e.target.value)}
                    placeholder="25.7617"
                  />
                  <Input
                    type="number"
                    step="any"
                    value={longitude}
                    onChange={(e) => setLongitude(e.target.value)}
                    placeholder="-80.1918"
                  />
                </div>
                <p className="text-xs text-zinc-500 mt-1">
                  Use latlong.net to find coordinates.
                </p>
              </div>
            </div>
          </details>
          </div>
          {error && <p className="mt-2 shrink-0 text-sm text-red-400">{error}</p>}
          <DialogFooter className="shrink-0">
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
