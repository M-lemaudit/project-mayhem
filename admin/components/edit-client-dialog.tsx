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
  const [minGapMinutes, setMinGapMinutes] = useState(
    typeof filters.minGapMinutes === 'number' ? String(filters.minGapMinutes) : ''
  );
  const [vehicleTypes, setVehicleTypes] = useState<string[]>(
    Array.isArray(filters.allowedVehicleTypes) ? (filters.allowedVehicleTypes as string[]) : []
  );
  const [timezone, setTimezone] = useState(bot.timezone ?? 'America/New_York');
  const [locale, setLocale] = useState(bot.locale ?? 'en-US');
  const [latitude, setLatitude] = useState(
    bot.latitude != null ? String(bot.latitude) : DEFAULT_LAT
  );
  const [longitude, setLongitude] = useState(
    bot.longitude != null ? String(bot.longitude) : DEFAULT_LONG
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
      setMinGapMinutes(
        typeof f.minGapMinutes === 'number' ? String(f.minGapMinutes) : ''
      );
      setVehicleTypes(
        Array.isArray(f.allowedVehicleTypes) ? (f.allowedVehicleTypes as string[]) : []
      );
      setTimezone(bot.timezone ?? 'America/New_York');
      setLocale(bot.locale ?? 'en-US');
      setLatitude(bot.latitude != null ? String(bot.latitude) : DEFAULT_LAT);
      setLongitude(bot.longitude != null ? String(bot.longitude) : DEFAULT_LONG);
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
      const updates: {
        name?: string;
        email?: string;
        password?: string;
        minPrice?: number;
        minHoursFromNow?: number;
        minGapMinutes?: number;
        vehicleTypes?: string[];
        timezone?: string;
        locale?: string;
        latitude?: number;
        longitude?: number;
      } = {
        name: name.trim() || undefined,
        email: email.trim() || undefined,
        minPrice: parseFloat(minPrice) || undefined,
        minHoursFromNow: minHoursFromNow ? parseInt(minHoursFromNow, 10) : undefined,
        minGapMinutes: minGapMinutes === '' ? null : parseInt(minGapMinutes, 10),
        vehicleTypes,
        timezone: timezone.trim() || undefined,
        locale: locale.trim() || undefined,
        latitude: latitude !== '' ? parseFloat(latitude) : undefined,
        longitude: longitude !== '' ? parseFloat(longitude) : undefined,
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
            <label className="block text-sm text-zinc-400 mb-1.5">
              Min gap (minutes) with existing rides
            </label>
            <Input
              type="number"
              min={0}
              placeholder="e.g. 30"
              value={minGapMinutes}
              onChange={(e) => setMinGapMinutes(e.target.value)}
            />
            <p className="text-xs text-zinc-500 mt-1">
              Reject offers that start within this many minutes of a booked ride. Leave empty to disable.
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
              {loading ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
