'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Play,
  Square,
  Settings,
  Save,
  Check,
  Plane,
  MapPin,
  Clock,
  Car,
  CalendarOff,
  Globe,
  AlertCircle,
  Plus,
  X,
} from 'lucide-react';
import { supabase, type BotRow, type AcceptedOfferRow } from '@/lib/supabase';
import { updateClient, toggleClientStatus } from '@/app/actions/bots';
import { AppShell } from '@/components/app-shell';
import { CatchBoard } from '@/components/catch-board';
import { FullPageLoader } from '@/components/full-page-loader';
import { TimeframePicker } from '@/components/timeframe-picker';
import { Sparkline } from '@/components/sparkline';
import { DualRange } from '@/components/dual-range';
import { StatusDot, statusLabelOf } from '@/components/status-dot';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { rangeFor, money, type PresetKey } from '@/lib/timeframe';
import { madePayBooked, bucketSeries, primaryCurrency } from '@/lib/metrics';

const OFFER_COLUMNS =
  'id, bot_id, offer_id, price, pickup_at, created_at, finished_price, finished_currency, completed_at, reconciled_at';

const VEHICLES = [
  { id: 'business', label: 'Business' },
  { id: 'van', label: 'Van' },
  { id: 'electric', label: 'Electric' },
  { id: 'first', label: 'First' },
];

/** Slider ceiling for distance; the engine reads this value as "no upper limit". */
const DISTANCE_MAX_KM = 5000;

const toNumber = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim()) return Number(v);
  return NaN;
};

/** A pickup-window boundary: whole hour, 0..24 (24 and 0 both mean midnight). */
const asHour = (v: unknown): number | null => {
  const n = toNumber(v);
  return Number.isInteger(n) && n >= 0 && n <= 24 ? n : null;
};

const asNonNegative = (v: unknown): number | null => {
  const n = toNumber(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

interface AccountPageProps {
  params: { id: string };
}

export default function AccountPage({ params }: AccountPageProps) {
  const { id } = params;
  const router = useRouter();
  const [bot, setBot] = useState<BotRow | null>(null);
  const [offers, setOffers] = useState<AcceptedOfferRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const getTodayIsoDateInTimezone = (timezoneId?: string | null): string => {
    const tz = typeof timezoneId === 'string' ? timezoneId.trim() : '';
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz || undefined,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    } catch {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  };

  // Filter states (unchanged logic — same filter keys the engine reads)
  const [minPrice, setMinPrice] = useState(40);
  const [maxPrice, setMaxPrice] = useState(400);
  const [minDistance, setMinDistance] = useState(0);
  const [maxDistance, setMaxDistance] = useState(5000);
  const [blackoutDateInput, setBlackoutDateInput] = useState('');
  const [blackoutDates, setBlackoutDates] = useState<string[]>([]);
  const [allowedStartDate, setAllowedStartDate] = useState('');
  const [allowedEndDate, setAllowedEndDate] = useState('');
  const [minGapMinutes, setMinGapMinutes] = useState(0);
  const [minLeadHours, setMinLeadHours] = useState(0);
  const [maxLeadHours, setMaxLeadHours] = useState(0);
  const [workingHoursStart, setWorkingHoursStart] = useState(6);
  const [workingHoursEnd, setWorkingHoursEnd] = useState(22);
  const [rideType, setRideType] = useState('Both');
  const [vehicleClasses, setVehicleClasses] = useState<string[]>(['first']);
  const [allowedAirlines, setAllowedAirlines] = useState<string[]>([]);
  const [airportDirection, setAirportDirection] = useState<'both' | 'pickup' | 'dropoff'>('both');
  const [allowedPickupCities, setAllowedPickupCities] = useState<string[]>([]);
  const [allowedDropoffCities, setAllowedDropoffCities] = useState<string[]>([]);
  const [timezone, setTimezone] = useState('Europe/Paris');
  const [isDirty, setIsDirty] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  // Settings modal
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [updatingAccount, setUpdatingAccount] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);

  // Quick-stats timeframe
  const [preset, setPreset] = useState<PresetKey>('this_month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  useEffect(() => {
    async function fetchBot() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push('/login');
        return;
      }
      const { data, error } = await supabase
        .from('bots')
        .select('*')
        .eq('id', id)
        .eq('user_id', user.id)
        .single();

      if (error || !data) {
        router.push('/dashboard');
        return;
      }

      const botData = data as BotRow;
      setBot(botData);

      const f = botData.filters || {};
      setMinPrice(Math.min(Number(f.minPrice || f.min_price || 40), 5000));
      setMaxPrice(Math.min(Number(f.maxPrice || f.max_price || 400), 5000));
      setMinDistance(Math.min(Number(f.minDistance || f.min_distance || 0), 5000));
      setMaxDistance(Math.min(Number(f.maxDistance || f.max_distance || 5000), 5000));
      const boRaw = (f.blackoutDates as string[] | undefined) ?? [];
      const todayIso = getTodayIsoDateInTimezone(botData.timezone || 'Europe/Paris');
      setBlackoutDates(
        Array.isArray(boRaw)
          ? boRaw.map((d) => (typeof d === 'string' ? d.trim() : '')).filter(Boolean).filter((d) => d >= todayIso)
          : []
      );
      setAllowedStartDate(String((typeof f.allowedStartDate === 'string' && f.allowedStartDate) || ''));
      setAllowedEndDate(String((typeof f.allowedEndDate === 'string' && f.allowedEndDate) || ''));
      // The runtime reads the `working_hours` / `min_gap_minutes` columns in
      // preference to the filters JSON, so the screen has to do the same —
      // otherwise it shows values the fleet is not actually using.
      const wh = botData.working_hours;
      setMinGapMinutes(
        asNonNegative(botData.min_gap_minutes) ??
          asNonNegative(f.minGapMinutes) ??
          asNonNegative(f.min_gap_minutes) ??
          0
      );
      setMinLeadHours(asNonNegative(f.minLeadHours) ?? asNonNegative(f.min_lead_hours) ?? 0);
      setMaxLeadHours(asNonNegative(f.maxLeadHours) ?? asNonNegative(f.max_lead_hours) ?? 0);
      setWorkingHoursStart(
        asHour(wh?.start) ?? asHour(f.workingHoursStart) ?? asHour(f.working_hours_start) ?? 6
      );
      setWorkingHoursEnd(
        asHour(wh?.end) ?? asHour(f.workingHoursEnd) ?? asHour(f.working_hours_end) ?? 22
      );
      const storedRideType = String(f.rideType || f.ride_type || 'Both').toLowerCase();
      setRideType(storedRideType === 'transfer' ? 'Transfer' : storedRideType === 'hourly' ? 'Hourly' : 'Both');
      setVehicleClasses((Array.isArray(f.allowedVehicleTypes) ? f.allowedVehicleTypes : []) as string[]);
      const dirRaw = (f.allowedAirportDirections || f.allowed_airport_directions) as string[] | undefined;
      if (Array.isArray(dirRaw) && dirRaw.length > 0) {
        const norm = dirRaw.map((d) => (typeof d === 'string' ? d.trim().toLowerCase() : '')).filter((d) => d === 'pickup' || d === 'dropoff');
        if (norm.length === 1 && norm[0] === 'pickup') setAirportDirection('pickup');
        else if (norm.length === 1 && norm[0] === 'dropoff') setAirportDirection('dropoff');
        else setAirportDirection('both');
      } else {
        setAirportDirection('both');
      }
      const airlinesRaw =
        (f.allowedAirlines as string[] | undefined) ??
        (f.allowed_airlines as string[] | undefined) ??
        (f.includedAirlines as string[] | undefined) ??
        (f.included_airlines as string[] | undefined);
      setAllowedAirlines(
        Array.isArray(airlinesRaw)
          ? airlinesRaw.map((c) => (typeof c === 'string' ? c.trim().toUpperCase() : '')).filter(Boolean)
          : []
      );
      setAllowedPickupCities(
        (Array.isArray(f.allowedPickupCities) ? f.allowedPickupCities : (f.allowedZipCodes || f.allowed_zip_codes || [])) as string[]
      );
      setAllowedDropoffCities(
        (Array.isArray(f.allowedDropoffCities) ? f.allowedDropoffCities : (f.allowedZipCodes || f.allowed_zip_codes || [])) as string[]
      );
      setTimezone(botData.timezone || 'Europe/Paris');
      setEditName(botData.name || '');
      setEditEmail(botData.email || '');

      const { data: offerData } = await supabase
        .from('accepted_offers')
        .select(OFFER_COLUMNS)
        .eq('bot_id', id)
        .order('created_at', { ascending: false })
        .limit(2000);
      setOffers((offerData as AcceptedOfferRow[]) ?? []);

      setLoading(false);
    }
    fetchBot();
  }, [id, router]);

  const handleSave = async () => {
    setSaving(true);
    const todayIso = getTodayIsoDateInTimezone(timezone);
    const sanitizedBlackoutDates = blackoutDates
      .map((d) => (typeof d === 'string' ? d.trim() : ''))
      .filter(Boolean)
      .filter((d) => d >= todayIso)
      .filter((d, idx, arr) => arr.indexOf(d) === idx)
      .sort();
    const updatedFilters = {
      minPrice,
      maxPrice,
      minDistance,
      maxDistance,
      blackoutDates: sanitizedBlackoutDates,
      allowedStartDate,
      allowedEndDate,
      minGapMinutes,
      minLeadHours,
      maxLeadHours,
      workingHoursStart,
      workingHoursEnd,
      rideType: rideType.trim().toLowerCase(),
      allowedVehicleTypes: vehicleClasses,
      allowedAirportDirections:
        airportDirection === 'both' ? ['pickup', 'dropoff'] : airportDirection === 'pickup' ? ['pickup'] : ['dropoff'],
      allowedAirlines,
      allowedPickupCities,
      allowedDropoffCities,
    };

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push('/login');
      return;
    }
    const { error } = await supabase
      .from('bots')
      .update({
        filters: updatedFilters,
        timezone,
        // Columns are the runtime's source of truth; write both representations
        // so the JSON and the columns can never drift apart again.
        working_hours: { start: workingHoursStart, end: workingHoursEnd },
        min_gap_minutes: minGapMinutes,
      })
      .eq('id', id)
      .eq('user_id', user.id);

    if (!error) {
      setIsDirty(false);
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    } else {
      alert('Could not save: ' + error.message);
    }
    setSaving(false);
  };

  const handleUpdateAccount = async () => {
    setUpdatingAccount(true);
    const result = await updateClient(id, {
      name: editName,
      email: editEmail,
      password: editPassword || undefined,
    });
    if (result.error) {
      alert('Could not update account: ' + result.error);
    } else {
      setBot((prev) => (prev ? { ...prev, name: editName, email: editEmail } : null));
      setIsSettingsOpen(false);
      setEditPassword('');
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    }
    setUpdatingAccount(false);
  };

  const handleToggleStatus = async () => {
    if (!bot) return;
    setIsUpdatingStatus(true);
    const result = await toggleClientStatus(id, bot.status);
    if (result.error) alert('Could not update status: ' + result.error);
    else if (result.data) setBot({ ...bot, status: result.data.status });
    setIsUpdatingStatus(false);
  };

  const dirty = (fn: () => void) => {
    setIsDirty(true);
    fn();
  };

  const toggleVehicleClass = (v: string) =>
    dirty(() => setVehicleClasses((prev) => (prev.includes(v) ? prev.filter((c) => c !== v) : [...prev, v])));

  const addBlackoutDate = () => {
    const value = blackoutDateInput.trim();
    if (!value) return;
    const todayIso = getTodayIsoDateInTimezone(timezone);
    if (value < todayIso) {
      alert(`Blackout date can't be in the past. Today (${timezone}) is ${todayIso}.`);
      return;
    }
    if (!blackoutDates.includes(value)) dirty(() => setBlackoutDates([...blackoutDates, value]));
    setBlackoutDateInput('');
  };

  // Quick stats
  const range = useMemo(() => rangeFor(preset, customStart, customEnd), [preset, customStart, customEnd]);
  const metrics = useMemo(() => madePayBooked(offers, range), [offers, range]);
  const series = useMemo(() => bucketSeries(offers, range), [offers, range]);
  const cur = primaryCurrency(metrics.byCurrency);
  const m = metrics.byCurrency.find((c) => c.currency === cur);
  const made = m?.made ?? 0;

  if (loading) return <FullPageLoader message="Loading bot…" />;

  const statusLabel = statusLabelOf(bot?.status ?? '');

  return (
    <AppShell>
      {/* Header */}
      <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h1 className="truncate font-display text-3xl text-ink md:text-4xl">{bot?.name || bot?.email}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span className="flex items-center gap-1.5">
              <StatusDot status={bot?.status ?? ''} /> {statusLabel}
            </span>
            <span className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" strokeWidth={1.75} />
              {bot?.last_seen ? `Seen ${new Date(bot.last_seen).toLocaleTimeString()}` : 'Never seen'}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {bot?.status === 'ERROR_AUTH' ? (
            <span className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/8 px-4 py-2 text-sm font-medium text-danger">
              <AlertCircle className="h-4 w-4" /> Auth error — re-enter password
            </span>
          ) : (
            <button
              type="button"
              onClick={handleToggleStatus}
              disabled={isUpdatingStatus}
              className={`flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                bot?.status === 'RUNNING'
                  ? 'border border-hairline bg-surface text-ink hover:border-danger/40 hover:text-danger'
                  : 'bg-accent text-paper hover:bg-accent-hover'
              }`}
            >
              {bot?.status === 'RUNNING' ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {isUpdatingStatus ? 'Working…' : bot?.status === 'RUNNING' ? 'Stop bot' : 'Start bot'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            aria-label="Account settings"
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-hairline bg-surface text-muted hover:text-ink"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Quick stats */}
      <section className="rounded-2xl border border-hairline bg-surface p-5 md:p-6">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="eyebrow !text-ink">Performance</h2>
          <TimeframePicker
            preset={preset}
            onPreset={setPreset}
            customStart={customStart}
            customEnd={customEnd}
            onCustomStart={setCustomStart}
            onCustomEnd={setCustomEnd}
          />
        </div>
        <div className="grid grid-cols-2 gap-6">
          <QuickStat label="Booked" value={String(metrics.booked)} />
          <QuickStat label="Made" value={money(made, cur)} />
        </div>
        {series.points.length > 0 && (
          <div className="mt-5 border-t border-hairline pt-4">
            <Sparkline values={series.points.map((p) => p.made)} width={520} height={40} className="w-full" />
          </div>
        )}
      </section>

      {/* Catch board */}
      <div className="mt-6">
        <CatchBoard mode="bot" botId={id} />
      </div>

      {/* Parameters */}
      <div className="mt-10 space-y-6">
        <h2 className="font-display text-xl text-ink">Parameters</h2>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Price & distance */}
          <Section icon={<span className="font-display text-lg text-accent">€</span>} title="Price & distance" desc="Accept only offers inside these bounds.">
            <Slider label="Price" valueLabel={`€${minPrice} – €${maxPrice}`}>
              <DualRange bound={[40, 5000]} value={[minPrice, maxPrice]} onChange={([a, b]) => dirty(() => { setMinPrice(a); setMaxPrice(b); })} />
            </Slider>
            <Slider
              label="Distance"
              valueLabel={maxDistance >= DISTANCE_MAX_KM ? `${minDistance} km – no limit` : `${minDistance} – ${maxDistance} km`}
            >
              <DualRange bound={[0, DISTANCE_MAX_KM]} value={[minDistance, maxDistance]} onChange={([a, b]) => dirty(() => { setMinDistance(a); setMaxDistance(b); })} />
            </Slider>
            <p className="-mt-1 text-xs text-muted">
              Ride distance in km. Sliding the upper handle to the far right ({DISTANCE_MAX_KM} km) removes the cap entirely.
            </p>
          </Section>

          {/* Schedule */}
          <Section icon={<Clock className="h-5 w-5 text-accent" strokeWidth={1.75} />} title="Schedule" desc="Spacing, lead time and the pickup hours to accept.">
            <SingleSlider label="Min gap between rides" value={minGapMinutes} unit="min" min={0} max={240} onChange={(v) => dirty(() => setMinGapMinutes(v))} />
            <SingleSlider label="Min lead time" value={minLeadHours} unit="h" min={0} max={72} onChange={(v) => dirty(() => setMinLeadHours(v))} />
            <p className="-mt-1 text-xs text-muted">
              Blacklane allows free cancellation when a ride is &gt;24h away — keep lead time inside that window for safety.
            </p>
            <SingleSlider label="Max lead time" value={maxLeadHours} unit="h" min={0} max={72} zeroLabel="No limit" onChange={(v) => dirty(() => setMaxLeadHours(v))} />
            <p className="-mt-1 text-xs text-muted">
              Rejects offers starting further ahead than this. 0 = no limit; 24 keeps the bot on same-day jobs only.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="Pickup from (h)" value={workingHoursStart} min={0} max={24} onChange={(v) => dirty(() => setWorkingHoursStart(v))} />
              <NumberField label="Pickup until (h)" value={workingHoursEnd} min={0} max={24} onChange={(v) => dirty(() => setWorkingHoursEnd(v))} />
            </div>
            <p className="-mt-1 text-xs text-muted">
              These bound the <span className="text-ink">ride&apos;s pickup hour</span> in the base timezone — not the hours the bot hunts, which is always around the clock. A start later than the end wraps overnight (22 → 6 = nights only).
            </p>
          </Section>
        </div>

        {/* Ride preferences */}
        <Section icon={<Car className="h-5 w-5 text-accent" strokeWidth={1.75} />} title="Ride preferences" desc="Which ride types and vehicle classes to accept.">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <SelectField label="Ride type" value={rideType} onChange={(v) => dirty(() => setRideType(v))} options={['Both', 'Transfer', 'Hourly']} />
            <div>
              <FieldLabel>Vehicle class</FieldLabel>
              <div className="grid grid-cols-2 gap-2">
                {VEHICLES.map((v) => {
                  const on = vehicleClasses.includes(v.id);
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => toggleVehicleClass(v.id)}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        on ? 'border-accent bg-accent/8 text-accent' : 'border-hairline bg-surface text-muted hover:border-ink/30'
                      }`}
                    >
                      <span className={`flex h-4 w-4 items-center justify-center rounded border ${on ? 'border-accent' : 'border-hairline'}`}>
                        {on && <Check className="h-3 w-3" strokeWidth={3} />}
                      </span>
                      {v.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Section>

        {/* Airport & airline */}
        <Section icon={<Plane className="h-5 w-5 text-accent" strokeWidth={1.75} />} title="Airport & airline rules" desc="Allowed airport legs and blocked airline codes.">
          <SelectField
            label="Airport direction"
            value={airportDirection}
            onChange={(v) => dirty(() => setAirportDirection(v as 'both' | 'pickup' | 'dropoff'))}
            options={[
              { value: 'both', label: 'Pickup & dropoff' },
              { value: 'pickup', label: 'Pickup only' },
              { value: 'dropoff', label: 'Dropoff only' },
            ]}
          />
          <ChipInput
            label="Blocked airline codes"
            placeholder="e.g. EK, AF, LH"
            values={allowedAirlines}
            transform={(s) => s.trim().toUpperCase()}
            onChange={(next) => dirty(() => setAllowedAirlines(next))}
            emptyText="No airlines blocked. All airlines accepted when a flight number is present."
          />
        </Section>

        {/* Cities */}
        <Section icon={<MapPin className="h-5 w-5 text-accent" strokeWidth={1.75} />} title="City filters" desc="Empty lists mean every city is accepted for that direction.">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <ChipInput
              label="Allowed pickup cities"
              placeholder="Add a pickup city"
              values={allowedPickupCities}
              transform={(s) => s.trim()}
              onChange={(next) => dirty(() => setAllowedPickupCities(next))}
              emptyText="All pickup cities accepted."
            />
            <ChipInput
              label="Allowed dropoff cities"
              placeholder="Add a dropoff city"
              values={allowedDropoffCities}
              transform={(s) => s.trim()}
              onChange={(next) => dirty(() => setAllowedDropoffCities(next))}
              emptyText="All dropoff cities accepted."
            />
          </div>
        </Section>

        {/* Dates */}
        <Section icon={<CalendarOff className="h-5 w-5 text-accent" strokeWidth={1.75} />} title="Date windows" desc="Blackout dates and an optional static time window.">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div>
              <FieldLabel>Blackout dates</FieldLabel>
              <form onSubmit={(e) => { e.preventDefault(); addBlackoutDate(); }} className="flex gap-2">
                <input
                  type="date"
                  value={blackoutDateInput}
                  onChange={(e) => setBlackoutDateInput(e.target.value)}
                  className="flex-1 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
                />
                <button type="submit" className="rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink hover:border-ink/30">
                  Add
                </button>
              </form>
              {blackoutDates.length === 0 ? (
                <p className="mt-3 text-xs text-muted">No blackout dates. All pickup dates allowed.</p>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  {blackoutDates.map((d) => (
                    <Chip key={d} label={d} onRemove={() => dirty(() => setBlackoutDates(blackoutDates.filter((x) => x !== d)))} />
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-3">
              <DateTimeField label="Allowed start (inclusive)" value={allowedStartDate} onChange={(v) => dirty(() => setAllowedStartDate(v))} />
              <DateTimeField label="Allowed end (inclusive)" value={allowedEndDate} onChange={(v) => dirty(() => setAllowedEndDate(v))} />
              <p className="text-xs text-muted">Empty = no restriction on that side. Interpreted in the base timezone.</p>
            </div>
          </div>
        </Section>

        {/* Stealth */}
        <Section icon={<Globe className="h-5 w-5 text-accent" strokeWidth={1.75} />} title="Timezone" desc="Used for blackout dates and static windows.">
          <SelectField
            label="Base timezone"
            value={timezone}
            onChange={(v) => dirty(() => setTimezone(v))}
            options={[
              { value: 'Europe/Paris', label: 'Europe/Paris (GMT+1)' },
              { value: 'Europe/London', label: 'Europe/London (GMT)' },
              { value: 'America/New_York', label: 'America/New_York (GMT-5)' },
              { value: 'Asia/Dubai', label: 'Asia/Dubai (GMT+4)' },
              { value: 'Asia/Tokyo', label: 'Asia/Tokyo (GMT+9)' },
            ]}
          />
        </Section>
      </div>

      {/* Sticky save bar */}
      {(isDirty || showSuccess) && (
        <div className="sticky bottom-4 z-30 mt-8 flex items-center justify-end gap-4 rounded-2xl border border-hairline bg-surface/95 px-5 py-3 backdrop-blur">
          {showSuccess && (
            <span className="flex items-center gap-2 text-sm font-medium text-accent">
              <Check className="h-4 w-4" /> Saved
            </span>
          )}
          {isDirty && (
            <>
              <button type="button" onClick={() => window.location.reload()} className="text-sm text-muted hover:text-ink">
                Discard
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-medium text-paper hover:bg-accent-hover disabled:opacity-50"
              >
                <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save changes'}
              </button>
            </>
          )}
        </div>
      )}

      {/* Settings modal */}
      <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Account settings</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <FieldLabel>Label</FieldLabel>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} className="w-full rounded-lg border border-hairline bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-accent" placeholder="My bot" />
            </div>
            <div>
              <FieldLabel>Blacklane email</FieldLabel>
              <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} className="w-full rounded-lg border border-hairline bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-accent" />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <FieldLabel>New password</FieldLabel>
                <span className="text-xs text-muted">Leave empty to keep current</span>
              </div>
              <input type="password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} className="w-full rounded-lg border border-hairline bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-accent" placeholder="••••••••••••" />
            </div>
          </div>
          <DialogFooter>
            <button type="button" onClick={() => setIsSettingsOpen(false)} className="rounded-lg border border-hairline bg-surface px-4 py-2 text-sm text-muted hover:text-ink">
              Cancel
            </button>
            <button type="button" onClick={handleUpdateAccount} disabled={updatingAccount} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-paper hover:bg-accent-hover disabled:opacity-50">
              <Check className="h-4 w-4" /> {updatingAccount ? 'Saving…' : 'Update account'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

/* ---------- small presentational helpers ---------- */

function QuickStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="eyebrow text-[10px]">{label}</p>
      <p className={`font-display tabular text-2xl ${accent ? 'text-accent' : 'text-ink'}`}>{value}</p>
    </div>
  );
}

function Section({ icon, title, desc, children }: { icon: React.ReactNode; title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-hairline bg-surface p-5 md:p-6">
      <div className="mb-5 flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-accent/8">{icon}</span>
        <div>
          <h3 className="font-display text-lg text-ink">{title}</h3>
          <p className="text-xs text-muted">{desc}</p>
        </div>
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="mb-1.5 block text-xs font-medium text-muted">{children}</label>;
}

function Slider({ label, valueLabel, children }: { label: string; valueLabel: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm text-ink">{label}</span>
        <span className="font-mono text-xs text-muted">{valueLabel}</span>
      </div>
      {children}
    </div>
  );
}

function SingleSlider({ label, value, unit, min, max, zeroLabel, onChange }: { label: string; value: number; unit: string; min: number; max: number; zeroLabel?: string; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm text-ink">{label}</span>
        <span className="font-mono text-xs text-muted">{zeroLabel && value === 0 ? zeroLabel : `${value} ${unit}`}</span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-1 w-full cursor-pointer appearance-none rounded-full bg-paper accent-accent" />
    </div>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value))))}
        className="w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
      />
    </div>
  );
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: (string | { value: string; label: string })[] }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
      >
        {options.map((o) => {
          const opt = typeof o === 'string' ? { value: o, label: o } : o;
          return (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          );
        })}
      </select>
    </div>
  );
}

function DateTimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <input
          type="datetime-local"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />
        {value && (
          <button type="button" onClick={() => onChange('')} aria-label="Clear" className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-muted hover:text-danger">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="flex items-center gap-1.5 rounded-lg border border-hairline bg-paper px-2.5 py-1 text-xs text-ink">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="text-muted hover:text-danger">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function ChipInput({
  label,
  placeholder,
  values,
  transform,
  onChange,
  emptyText,
}: {
  label: string;
  placeholder: string;
  values: string[];
  transform: (s: string) => string;
  onChange: (next: string[]) => void;
  emptyText: string;
}) {
  const [text, setText] = useState('');
  const add = () => {
    const v = transform(text);
    if (v && !values.includes(v)) onChange([...values, v]);
    setText('');
  };
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <form onSubmit={(e) => { e.preventDefault(); add(); }} className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          className="flex-1 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />
        <button type="submit" aria-label="Add" className="flex items-center gap-1 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink hover:border-ink/30">
          <Plus className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </form>
      {values.length === 0 ? (
        <p className="mt-3 text-xs text-muted">{emptyText}</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {values.map((v) => (
            <Chip key={v} label={v} onRemove={() => onChange(values.filter((x) => x !== v))} />
          ))}
        </div>
      )}
    </div>
  );
}
