/**
 * Test script: FilterEngine gap logic (minGapMinutes vs existing rides).
 * Run: npm run build && npm run test:gap
 */

import { FilterEngine, type BotFilters, type ExistingRide, type OfferShape, type MatchResult } from '../core';

// Base: today noon UTC
const base = new Date();
base.setUTCHours(12, 0, 0, 0);
const t = (h: number, m: number) => {
  const d = new Date(base);
  d.setUTCHours(h, m, 0, 0);
  return d.toISOString();
};

const filters: BotFilters = {
  minPrice: 10,
  allowedVehicleTypes: [],
  minGapMinutes: 30,
};

// Existing ride: 14:00 - 15:00 UTC
const existingRides: ExistingRide[] = [
  { start_at: t(14, 0), end_at: t(15, 0) },
];

function offer(start: string, end: string, price = 50): OfferShape {
  return {
    price,
    attributes: { starts_at: start, end_at: end },
  };
}

let passed = 0;
let failed = 0;

function ok(name: string, result: MatchResult, expectMatch: boolean) {
  if (result.match === expectMatch) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ ${name}: expected match=${expectMatch}, got match=${result.match} (reason: ${result.reason})`);
    failed++;
  }
}

console.log('FilterEngine gap tests (minGapMinutes=30, existing ride 14:00-15:00)\n');

// Overlap: offer 14:30-15:30 → reject
const r1 = FilterEngine.isMatch(offer(t(14, 30), t(15, 30)), filters, existingRides);
ok('Overlap (offer 14:30-15:30)', r1, false);

// Too close after ride: offer 15:00-16:00 (starts when ride ends, gap=0) → reject
const r2 = FilterEngine.isMatch(offer(t(15, 0), t(16, 0)), filters, existingRides);
ok('Gap after ride = 0 min (15:00-16:00)', r2, false);

// Too close after: offer 15:29-16:00 (gap 29 min) → reject
const r3 = FilterEngine.isMatch(offer(t(15, 29), t(16, 0)), filters, existingRides);
ok('Gap after ride = 29 min', r3, false);

// Exactly 30 min after: offer 15:30-16:30 → accept
const r4 = FilterEngine.isMatch(offer(t(15, 30), t(16, 30)), filters, existingRides);
ok('Gap after ride = 30 min (15:30 start)', r4, true);

// Too close before: offer 13:00-13:31 (ends 29 min before 14:00) → reject
const r5 = FilterEngine.isMatch(offer(t(13, 0), t(13, 31)), filters, existingRides);
ok('Gap before ride = 29 min', r5, false);

// Exactly 30 min before: offer 13:00-13:30 (ends at 13:30, ride at 14:00) → accept
const r6 = FilterEngine.isMatch(offer(t(13, 0), t(13, 30)), filters, existingRides);
ok('Gap before ride = 30 min (end 13:30)', r6, true);

// No existing rides → offer should match (gap check skipped)
const r7 = FilterEngine.isMatch(offer(t(14, 30), t(15, 30)), filters, []);
ok('No existing rides → overlap allowed', r7, true);

// minGapMinutes = 0 → gap block skipped, overlap not checked (offer matches)
const filtersNoGap: BotFilters = { ...filters, minGapMinutes: 0 };
const r8 = FilterEngine.isMatch(offer(t(14, 30), t(15, 30)), filtersNoGap, existingRides);
ok('minGapMinutes=0 → overlap not checked (match)', r8, true);

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
