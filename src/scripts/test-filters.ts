/**
 * Test script: FilterEngine distance, date-window (timezone-aware) and max-lead-hours filters.
 * Run: npm run build && npm run test:filters
 */

import { FilterEngine, type BotFilters, type OfferShape, type MatchResult } from '../core';

const TZ = 'America/New_York';

const base: BotFilters = {
  minPrice: 0,
  allowedVehicleTypes: [],
};

/** Offer with an optional distance; price/vehicle filters are neutral in these tests. */
function offer(attrs: Record<string, unknown>): OfferShape {
  return { price: 100, attributes: { ...attrs } };
}

/** ISO instant N hours from now (for lead-time tests). */
function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3600 * 1000).toISOString();
}

let passed = 0;
let failed = 0;

function ok(name: string, result: MatchResult, expectMatch: boolean) {
  if (result.match === expectMatch) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(
      `  ❌ ${name}: expected match=${expectMatch}, got match=${result.match} (reason: ${result.reason})`
    );
    failed++;
  }
}

// ── Distance ────────────────────────────────────────────────────────
console.log('\nDistance filter (minDistance=20, maxDistance=100)\n');

const distFilters: BotFilters = { ...base, minDistance: 20, maxDistance: 100 };

ok('10km < min 20km → reject', FilterEngine.isMatch(offer({ distance_km: 10 }), distFilters), false);
ok(
  '150km > max 100km → reject',
  FilterEngine.isMatch(offer({ distance_km: 150 }), distFilters),
  false
);
ok('50km inside range → accept', FilterEngine.isMatch(offer({ distance_km: 50 }), distFilters), true);
ok(
  'numeric string "50.5" inside range → accept',
  FilterEngine.isMatch(offer({ distance_km: '50.5' }), distFilters),
  true
);
ok(
  'unknown distance (no distance_km) → accept (permissive)',
  FilterEngine.isMatch(offer({}), distFilters),
  true
);
ok(
  'unparseable distance ("n/a") → accept (permissive)',
  FilterEngine.isMatch(offer({ distance_km: 'n/a' }), distFilters),
  true
);
ok(
  'boundary: exactly min → accept',
  FilterEngine.isMatch(offer({ distance_km: 20 }), distFilters),
  true
);
ok(
  'boundary: exactly max → accept',
  FilterEngine.isMatch(offer({ distance_km: 100 }), distFilters),
  true
);
ok(
  'maxDistance=5000 (slider max) is unbounded → 9000km accepted',
  FilterEngine.isMatch(offer({ distance_km: 9000 }), { ...base, minDistance: 0, maxDistance: 5000 }),
  true
);
ok(
  'minDistance=0 is a no-op → 1km accepted',
  FilterEngine.isMatch(offer({ distance_km: 1 }), { ...base, minDistance: 0, maxDistance: 5000 }),
  true
);

// ── Date window (America/New_York) ──────────────────────────────────
console.log('\nDate window filter (2026-09-10 .. 2026-09-20, America/New_York)\n');

const windowFilters: BotFilters = {
  ...base,
  allowedStartDate: '2026-09-10',
  allowedEndDate: '2026-09-20',
};

const win = (startsAtIso: string, filters: BotFilters = windowFilters): MatchResult =>
  FilterEngine.isMatch(offer({ starts_at: startsAtIso }), filters, [], [], TZ);

// 2026-09-20 10:00 EDT = 14:00Z — ON the inclusive end date (the broken regression).
ok('10:00 local ON the end date → accept', win('2026-09-20T14:00:00Z'), true);
// 2026-09-20 23:30 EDT = 2026-09-21T03:30Z — still the end date locally.
ok('23:30 local ON the end date → accept', win('2026-09-21T03:30:00Z'), true);
// 2026-09-21 10:00 EDT = 14:00Z — the day after the end date.
ok('day after the end date → reject', win('2026-09-21T14:00:00Z'), false);
// 2026-09-09 23:00 EDT = 2026-09-10T03:00Z — old UTC parse let this through.
ok('23:00 local the evening BEFORE the start date → reject', win('2026-09-10T03:00:00Z'), false);
// 2026-09-10 00:00 EDT = 04:00Z — first local instant of the start date.
ok('midnight local ON the start date → accept', win('2026-09-10T04:00:00Z'), true);

console.log('\nDate window filter (datetime-local bounds)\n');

const dtFilters: BotFilters = {
  ...base,
  allowedStartDate: '2026-09-10T08:00',
  allowedEndDate: '2026-09-20T18:00',
};
// 2026-09-10 07:59 EDT = 11:59Z
ok('one minute before the datetime-local start → reject', win('2026-09-10T11:59:00Z', dtFilters), false);
// 2026-09-10 08:00 EDT = 12:00Z
ok('exactly the datetime-local start → accept', win('2026-09-10T12:00:00Z', dtFilters), true);
// 2026-09-20 18:00 EDT = 22:00Z
ok('exactly the datetime-local end → accept', win('2026-09-20T22:00:00Z', dtFilters), true);
// 2026-09-20 18:01 EDT = 22:01Z
ok('one minute after the datetime-local end → reject', win('2026-09-20T22:01:00Z', dtFilters), false);

console.log('\nDate window filter (US DST boundaries)\n');

// DST starts 2026-03-08 (EST -05:00 → EDT -04:00 at 07:00Z).
const dstStartFilters: BotFilters = {
  ...base,
  allowedStartDate: '2026-03-08',
  allowedEndDate: '2026-03-08',
};
// 2026-03-07 23:30 EST = 2026-03-08T04:30Z — before the local start of 03-08.
ok('evening before DST-start day → reject', win('2026-03-08T04:30:00Z', dstStartFilters), false);
// 2026-03-08 09:00 EDT = 13:00Z — inside the DST-start day.
ok('morning of DST-start day → accept', win('2026-03-08T13:00:00Z', dstStartFilters), true);
// 2026-03-08 23:30 EDT = 2026-03-09T03:30Z — last half hour of the DST-start day.
ok('23:30 local on DST-start day → accept', win('2026-03-09T03:30:00Z', dstStartFilters), true);
// 2026-03-09 00:30 EDT = 04:30Z — the next local day.
ok('day after DST-start day → reject', win('2026-03-09T04:30:00Z', dstStartFilters), false);

// DST ends 2026-11-01 (EDT -04:00 → EST -05:00 at 06:00Z).
const dstEndFilters: BotFilters = {
  ...base,
  allowedStartDate: '2026-11-01',
  allowedEndDate: '2026-11-01',
};
// 2026-11-01 23:30 EST = 2026-11-02T04:30Z — last half hour of the (25-hour) DST-end day.
ok('23:30 local on DST-end day → accept', win('2026-11-02T04:30:00Z', dstEndFilters), true);
// 2026-11-02 00:30 EST = 05:30Z — the next local day.
ok('day after DST-end day → reject', win('2026-11-02T05:30:00Z', dstEndFilters), false);

console.log('\nDate window filter (explicit-zone bound is honoured as-is)\n');

const zonedFilters: BotFilters = { ...base, allowedEndDate: '2026-09-20T12:00:00Z' };
ok('before the explicit-zone end instant → accept', win('2026-09-20T11:59:00Z', zonedFilters), true);
ok('after the explicit-zone end instant → reject', win('2026-09-20T12:01:00Z', zonedFilters), false);

console.log('\nDate window filter (unset = no-op)\n');
ok('no bounds set → any date accepted', win('2030-01-01T00:00:00Z', base), true);

// ── Max lead hours ──────────────────────────────────────────────────
console.log('\nMax lead hours filter\n');

const leadFilters: BotFilters = { ...base, maxHoursFromNow: 24 };

ok(
  'ride 30 days out with maxHoursFromNow=24 → reject',
  FilterEngine.isMatch(offer({ starts_at: hoursFromNow(24 * 30) }), leadFilters),
  false
);
ok(
  'same-day ride (3h out) with maxHoursFromNow=24 → accept',
  FilterEngine.isMatch(offer({ starts_at: hoursFromNow(3) }), leadFilters),
  true
);
ok(
  'maxHoursFromNow unset → 30 days out accepted',
  FilterEngine.isMatch(offer({ starts_at: hoursFromNow(24 * 30) }), base),
  true
);
ok(
  'maxHoursFromNow=0 is a no-op → 30 days out accepted',
  FilterEngine.isMatch(offer({ starts_at: hoursFromNow(24 * 30) }), {
    ...base,
    maxHoursFromNow: 0,
  }),
  true
);
ok(
  'min 6h / max 24h: 12h out → accept',
  FilterEngine.isMatch(offer({ starts_at: hoursFromNow(12) }), {
    ...base,
    minHoursFromNow: 6,
    maxHoursFromNow: 24,
  }),
  true
);
ok(
  'contradictory min 48h > max 24h → reject without crashing',
  FilterEngine.isMatch(offer({ starts_at: hoursFromNow(3) }), {
    ...base,
    minHoursFromNow: 48,
    maxHoursFromNow: 24,
  }),
  false
);

// ── Production config regression guard ──────────────────────────────
console.log('\nCurrent production filter shape must stay a no-op\n');

const prodLike: BotFilters = {
  minPrice: 0,
  allowedVehicleTypes: [],
  minDistance: 0,
  maxDistance: 5000,
};
ok(
  'minDistance=0 / maxDistance=5000 / no window / no max lead → accept',
  FilterEngine.isMatch(offer({ starts_at: hoursFromNow(24 * 45), distance_km: 742.3 }), prodLike),
  true
);

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
