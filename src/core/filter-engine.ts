/**
 * In-memory filter: decides if an offer is worth taking. No DB queries in hot loop.
 * New location-based filters use the JSON:API `included` array for pickup/dropoff resolution.
 */

import { isEnvFlagEnabled, logger } from '../utils';

const FILTER_TRACE_ENABLED = isEnvFlagEnabled(process.env.FILTER_TRACE);
const FILTER_TRACE_FULL_EVAL =
  FILTER_TRACE_ENABLED && isEnvFlagEnabled(process.env.FILTER_TRACE_FULL_EVAL);

/**
 * Mirrors the max position of the admin UI's distance slider. The UI treats that position as
 * "no limit" rather than a literal 5000 km cap, and every live bot stores exactly this value,
 * so anything at or above it must be read as "unbounded" — otherwise enabling the filter would
 * start rejecting the (hypothetical) 5000+ km offers nobody asked to exclude.
 */
const DISTANCE_UNBOUNDED_KM = 5000;

export interface BotFilters {
  minPrice: number;
  /** Optional max price (offers above this are skipped). */
  maxPrice?: number;
  allowedVehicleTypes: string[];
  /** Minimum ride distance in km. 0/undefined = no lower bound. */
  minDistance?: number;
  /** Maximum ride distance in km. >= DISTANCE_UNBOUNDED_KM (admin slider max) = no upper bound. */
  maxDistance?: number;
  /** Only match offers whose pickup/start (starts_at) is at least this many hours from now. */
  minHoursFromNow?: number;
  /** Only match offers whose pickup/start (starts_at) is at most this many hours from now. */
  maxHoursFromNow?: number;
  /** Working hours (machine local): start hour (0-23), default 6. */
  workingHoursStart?: number;
  /** Working hours (machine local): end hour (0-23), default 22. Inside = hour >= start && hour < end. */
  workingHoursEnd?: number;
  /** Minimum gap in minutes between the offered ride and any existing booked ride. */
  minGapMinutes?: number;

  // ── New Supabase-driven filters ──────────────────────────────────
  /** "transfer" | "hourly" | "both" — if empty/missing, accept all. */
  rideType?: string;
  /** Directions where airport legs are allowed: ['pickup'], ['dropoff'], or ['pickup','dropoff']. */
  allowedAirportDirections?: string[];
  /**
   * Airline codes to BLOCK when a flight_number is present (e.g. ["DAL","AF"]).
   * Empty = do not block any airline (accept all airlines).
   */
  allowedAirlines?: string[];
  /** ZIP/postal codes the chauffeur allows. Empty = accept all. */
  allowedZipCodes?: string[];
  /** ZIP/postal codes the chauffeur blocks. Empty = block none. */
  blockedZipCodes?: string[];
  /**
   * Pickup cities to BLOCK. Empty = do not block any pickup city (all pickup cities allowed).
   */
  allowedPickupCities?: string[];
  /**
   * Dropoff cities to BLOCK. Empty = do not block any dropoff city (all dropoff cities allowed).
   */
  allowedDropoffCities?: string[];
  /** Dates (YYYY-MM-DD, in bot timezone) where rides must be rejected. */
  blackoutDates?: string[];
  /** Static lower bound for ride start datetime (inclusive). */
  allowedStartDate?: string;
  /** Static upper bound for ride start datetime (inclusive). */
  allowedEndDate?: string;
}

/** Cached ride from Supabase (start_at, end_at as ISO strings). */
export interface ExistingRide {
  start_at: string;
  end_at: string;
}

/** Offer shape from API. Price can be in attributes.price (string) or root; starts_at in attributes. */
export interface OfferShape {
  price?: string | number;
  price_amount?: number;
  vehicle_type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A single resource from the JSON:API `included` array (e.g. a location). */
export interface IncludedResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

// ── Trace helpers (debug only, gated by env flags) ────────────────────────────

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  return typeof value;
}

function safeValue(value: unknown): unknown {
  if (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    const sample = value.slice(0, 3);
    return { length: value.length, sample };
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const sample: Record<string, unknown> = {};
    for (const key of keys.slice(0, 5)) {
      sample[key] = obj[key];
    }
    return { keys, sample };
  }
  return String(value);
}

interface TraceParams {
  offerId: string;
  filterName: string;
  op: string;
  leftLabel: string;
  leftValue: unknown;
  rightLabel?: string;
  rightValue?: unknown;
  passed: boolean;
}

function traceCompare(params: TraceParams): void {
  if (!FILTER_TRACE_ENABLED) return;
  const { offerId, filterName, op, leftLabel, leftValue, rightLabel, rightValue, passed } =
    params;

  const payload: Record<string, unknown> = {
    offerId,
    filter: filterName,
    op,
    result: passed ? 'PASS' : 'FAIL',
    left: {
      label: leftLabel,
      type: valueType(leftValue),
      value: safeValue(leftValue),
    },
  };

  if (rightLabel !== undefined) {
    payload.right = {
      label: rightLabel,
      type: valueType(rightValue),
      value: safeValue(rightValue),
    };
  }

  logger.info('[FILTER_TRACE]', payload);
}

// ── JSON:API helpers ───────────────────────────────────────────────

/** Resolve pickup & dropoff location objects from the JSON:API `included` array. */
export function resolveOfferLocations(
  offer: OfferShape,
  included: IncludedResource[]
): { pickup: IncludedResource | null; dropoff: IncludedResource | null } {
  const rels = offer.relationships as Record<string, { data?: { id?: string } }> | undefined;
  const pickupId = rels?.pickup_location?.data?.id;
  const dropoffId = rels?.dropoff_location?.data?.id;

  let pickup: IncludedResource | null = null;
  let dropoff: IncludedResource | null = null;

  for (const inc of included) {
    if (pickupId && inc.id === pickupId) pickup = inc;
    if (dropoffId && inc.id === dropoffId) dropoff = inc;
    if (pickup && dropoff) break;
  }
  return { pickup, dropoff };
}

const DATE_FIELDS = ['pickup_at', 'starts_at', 'scheduled_at', 'start_time', 'pickup_time', 'datetime'];

const PRICE_ATTR_KEYS = ['price', 'payout', 'total_price', 'price_amount', 'amount', 'total', 'formatted_price'];

/** Parse price from API: attributes.price (string "70.5") or root price/price_amount. Returns null if missing/invalid. */
export function getOfferPrice(offer: OfferShape): number | null {
  const attrs = offer?.attributes as Record<string, unknown> | undefined;
  // Try known keys first, then any attribute key containing "price", "payout", or "amount"
  let fromAttrs: unknown;
  for (const key of PRICE_ATTR_KEYS) {
    if (attrs?.[key] != null) {
      fromAttrs = attrs[key];
      break;
    }
  }
  if (fromAttrs == null && attrs && typeof attrs === 'object') {
    for (const key of Object.keys(attrs)) {
      const k = key.toLowerCase();
      if ((k.includes('price') || k.includes('payout') || k.includes('amount')) && attrs[key] != null) {
        fromAttrs = attrs[key];
        break;
      }
    }
  }
  const fromRootPrice = offer?.price;
  const fromPriceAmount = offer?.price_amount != null ? offer.price_amount : undefined;
  const raw =
    fromAttrs ??
    fromRootPrice ??
    fromPriceAmount;

  if (raw == null) {
    return null;
  }
  if (typeof raw === 'number') {
    if (Number.isNaN(raw)) {
      return null;
    }
    return raw;
  }
  if (typeof raw === 'string') {
    // API returns price as string, often with currency or formatting: "114,28 €", "€ 114.28", "70.5"
    const trimmed = raw.trim();
    const sanitized = trimmed.replace(/[^\d.,-]/g, '').replace(/,/g, '.');
    const n = parseFloat(sanitized);
    if (!Number.isNaN(n)) {
      return n;
    }
    return null;
  }
  return null;
}

/**
 * Read the great-circle ride distance (km) the offer normalizer puts in `attributes.distance_km`.
 * Returns null when the field is absent or unusable — callers must treat that as "unknown",
 * not as "zero".
 */
export function getOfferDistanceKm(offer: OfferShape): number | null {
  const raw = (offer?.attributes as Record<string, unknown> | undefined)?.distance_km;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const n = parseFloat(raw.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ── Timezone-aware date bound parsing ──────────────────────────────

/** A bound string that already pins an instant (trailing `Z` or `±HH:mm`). */
const EXPLICIT_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;

/**
 * UTC offset (ms) that `timeZone` is running at the given instant. Derived from formatted parts
 * because the platform exposes no direct offset API; `formatToParts` is the only zone database
 * access available without pulling in a dependency.
 */
function zoneOffsetMsAt(instantMs: number, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instantMs));
  } catch {
    // Unknown timezone id: signal "no offset available" so the caller can fall back.
    return Number.NaN;
  }

  const num = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : Number.NaN;
  };

  const year = num('year');
  const month = num('month');
  const day = num('day');
  // Some ICU builds render midnight as hour 24 in hour12:false mode.
  const hour = num('hour') === 24 ? 0 : num('hour');
  const minute = num('minute');
  const second = num('second');
  if ([year, month, day, hour, minute, second].some((n) => Number.isNaN(n))) {
    return Number.NaN;
  }

  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // Formatted parts are second-granular, so compare against the instant truncated to seconds.
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

/** Convert a wall-clock time in `timeZone` into the matching UTC instant (ms). */
function wallTimeToUtcMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  ms: number,
  timeZone: string
): number {
  const naiveUtc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const firstOffset = zoneOffsetMsAt(naiveUtc, timeZone);
  if (Number.isNaN(firstOffset)) return Number.NaN;
  const firstGuess = naiveUtc - firstOffset;
  // Second pass: across a DST transition the offset at the guessed instant differs from the one
  // at the naive instant, so re-derive it from the corrected instant before committing.
  const secondOffset = zoneOffsetMsAt(firstGuess, timeZone);
  if (Number.isNaN(secondOffset)) return firstGuess;
  return naiveUtc - secondOffset;
}

/**
 * Turn a stored `allowedStartDate`/`allowedEndDate` into the UTC instant it denotes in the bot's
 * timezone. Both bounds are documented as INCLUSIVE, so a date-only end bound covers the whole
 * local day (…23:59:59.999) instead of collapsing to that day's midnight UTC — which used to
 * reject essentially every ride on the last allowed day.
 * Returns null when the string cannot be parsed at all.
 */
function parseFilterBound(raw: string, kind: 'start' | 'end', timezoneId?: string): Date | null {
  const value = raw.trim();
  if (!value) return null;

  // An explicit zone means the author already pinned the instant: never re-interpret it.
  if (EXPLICIT_ZONE_RE.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const dateOnly = DATE_ONLY_RE.exec(value);
  const dateTime = dateOnly ? null : LOCAL_DATETIME_RE.exec(value);

  const parsed = dateOnly ?? dateTime;
  const tz = typeof timezoneId === 'string' ? timezoneId.trim() : '';
  if (parsed && tz) {
    const isDateOnly = dateOnly !== null;
    const endOfDay = isDateOnly && kind === 'end';
    const y = Number(parsed[1]);
    const mo = Number(parsed[2]);
    const d = Number(parsed[3]);
    const h = isDateOnly ? (endOfDay ? 23 : 0) : Number(parsed[4]);
    const mi = isDateOnly ? (endOfDay ? 59 : 0) : Number(parsed[5]);
    const s = isDateOnly ? (endOfDay ? 59 : 0) : Number(parsed[6] ?? 0);
    const ms = isDateOnly ? (endOfDay ? 999 : 0) : Number((parsed[7] ?? '0').padEnd(3, '0'));
    const utcMs = wallTimeToUtcMs(y, mo, d, h, mi, s, ms, tz);
    if (!Number.isNaN(utcMs)) return new Date(utcMs);
    // Invalid/unknown timezone id: fall through to the naive parse below.
  }

  const naive = new Date(value);
  if (Number.isNaN(naive.getTime())) return null;
  // Without a usable timezone we keep the historic naive parse, but a date-only end bound still
  // has to span its day or "inclusive" would remain a lie.
  if (dateOnly && kind === 'end') {
    return new Date(naive.getTime() + 24 * 3600 * 1000 - 1);
  }
  return naive;
}

/** Extract start date from offer (root or attributes.starts_at). Returns null if missing/invalid. */
function getOfferDate(offer: OfferShape): Date | null {
  for (const key of DATE_FIELDS) {
    const v = offer?.[key];
    if (v == null) continue;
    if (typeof v === 'number' && v > 0) return new Date(v);
    if (typeof v === 'string' && v.trim()) {
      const d = new Date(v.trim());
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  const attrs = offer?.attributes as Record<string, unknown> | undefined;
  if (attrs && typeof attrs === 'object') {
    for (const key of DATE_FIELDS) {
      const v = attrs[key];
      if (v == null) continue;
      if (typeof v === 'number' && v > 0) return new Date(v);
      if (typeof v === 'string' && v.trim()) {
        const d = new Date(v.trim());
        if (!Number.isNaN(d.getTime())) return d;
      }
    }
  }
  return null;
}

const END_DATE_FIELDS = ['end_at', 'ends_at', 'dropoff_at', 'drop_off_at'];

/** Extract end date from offer, or start + duration (duration in minutes in attributes). */
function getOfferEndDate(offer: OfferShape, startDate: Date | null): Date | null {
  const attrs = offer?.attributes as Record<string, unknown> | undefined;
  for (const key of END_DATE_FIELDS) {
    const v = attrs?.[key] ?? (offer as Record<string, unknown>)[key];
    if (v == null) continue;
    if (typeof v === 'number' && v > 0) return new Date(v);
    if (typeof v === 'string' && v.trim()) {
      const d = new Date(v.trim());
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  if (startDate && typeof attrs?.duration === 'number') {
    const end = new Date(startDate.getTime());
    end.setMinutes(end.getMinutes() + attrs.duration);
    return end;
  }
  return null;
}

/**
 * Check time gap between offered ride (OfferStart, OfferEnd) and existing rides.
 * Gap = minGapMinutes * 60 * 1000 (ms).
 * - Overlap: OfferStart < Ride.End AND OfferEnd > Ride.Start => REJECT.
 * - Buffer Before: OfferEnd before Ride.Start, (Ride.Start - OfferEnd) < Gap => REJECT.
 * - Buffer After: OfferStart after Ride.End, (OfferStart - Ride.End) < Gap => REJECT.
 * Returns true if conflict found.
 */
function checkTimeGap(
  offerStart: Date,
  offerEnd: Date,
  gapMs: number,
  existingRides: ExistingRide[]
): boolean {
  const offerStartMs = offerStart.getTime();
  const offerEndMs = offerEnd.getTime();
  for (const ride of existingRides) {
    const rideStartMs = new Date(ride.start_at).getTime();
    const rideEndMs = new Date(ride.end_at).getTime();
    if (Number.isNaN(rideStartMs) || Number.isNaN(rideEndMs)) continue;
    if (offerStartMs < rideEndMs && offerEndMs > rideStartMs) {
      return true;
    }
    if (offerEndMs <= rideStartMs && rideStartMs - offerEndMs < gapMs) {
      return true;
    }
    if (offerStartMs >= rideEndMs && offerStartMs - rideEndMs < gapMs) {
      return true;
    }
  }
  return false;
}

export interface MatchResult {
  match: boolean;
  reason: string;
}

export class FilterEngine {
  /**
   * Returns whether the offer passes filters and a short reason.
   * Uses optional chaining so missing JSON fields do not crash.
   * @param existingRides - Cached rides from Supabase (start_at > now) for time-gap check.
   * @param included - JSON:API `included` array (locations) for location-based filters.
   */
  static isMatch(
    offer: OfferShape,
    filters: BotFilters,
    existingRides: ExistingRide[] = [],
    included: IncludedResource[] = [],
    timezoneId?: string
  ): MatchResult {
    const offerIdRaw = (offer as Record<string, unknown>)?.id;
    const offerId = offerIdRaw != null ? String(offerIdRaw) : 'unknown';
    const useFullEval = FILTER_TRACE_FULL_EVAL;
    const failures: string[] = [];

    const fail = (filterName: string, reason: string, traceDetails?: Omit<TraceParams, 'offerId' | 'filterName' | 'passed'>): MatchResult | null => {
      if (traceDetails) {
        traceCompare({
          offerId,
          filterName,
          passed: false,
          ...traceDetails,
        });
      }
      if (useFullEval) {
        failures.push(reason);
        return null;
      }
      return reject(reason);
    };

    const price = getOfferPrice(offer);
    const attrs = offer?.attributes as Record<string, unknown> | undefined;
    const vehicleType = (attrs?.service_class ?? offer?.vehicle_type) as string | undefined;
    const typeStr = typeof vehicleType === 'string' ? vehicleType.trim().toLowerCase() : '';

    // ── Price ─────────────────────────────────────────────────────
    if (price == null) {
      const res = fail('price_present', 'Missing price', {
        op: '!= null',
        leftLabel: 'price',
        leftValue: price,
        rightLabel: 'required',
        rightValue: true,
      });
      if (res) return res;
    } else {
      traceCompare({
        offerId,
        filterName: 'price_present',
        op: '!= null',
        leftLabel: 'price',
        leftValue: price,
        rightLabel: 'required',
        rightValue: true,
        passed: true,
      });
      if (price < filters.minPrice) {
        const res = fail('minPrice', `Price too low (${price} < min ${filters.minPrice})`, {
          op: '>=',
          leftLabel: 'price',
          leftValue: price,
          rightLabel: 'minPrice',
          rightValue: filters.minPrice,
        });
        if (res) return res;
      } else {
        traceCompare({
          offerId,
          filterName: 'minPrice',
          op: '>=',
          leftLabel: 'price',
          leftValue: price,
          rightLabel: 'minPrice',
          rightValue: filters.minPrice,
          passed: true,
        });
      }
      if (typeof filters.maxPrice === 'number') {
        const passedMax = price <= filters.maxPrice;
        traceCompare({
          offerId,
          filterName: 'maxPrice',
          op: '<=',
          leftLabel: 'price',
          leftValue: price,
          rightLabel: 'maxPrice',
          rightValue: filters.maxPrice,
          passed: passedMax,
        });
        if (!passedMax) {
          const res = fail(
            'maxPrice',
            `Price too high (${price} > max ${filters.maxPrice})`,
            {
              op: '<=',
              leftLabel: 'price',
              leftValue: price,
              rightLabel: 'maxPrice',
              rightValue: filters.maxPrice,
            }
          );
          if (res) return res;
        }
      }
    }

    // ── Vehicle type ──────────────────────────────────────────────
    const allowed = filters.allowedVehicleTypes ?? [];
    if (allowed.length > 0 && typeStr) {
      const allowedLower = allowed.map((v) => v.toLowerCase());
      const passedVehicle = allowedLower.includes(typeStr);
      traceCompare({
        offerId,
        filterName: 'vehicleType',
        op: 'includes',
        leftLabel: 'vehicleType',
        leftValue: typeStr,
        rightLabel: 'allowedVehicleTypes',
        rightValue: allowed,
        passed: passedVehicle,
      });
      if (!passedVehicle) {
        const res = fail(
          'vehicleType',
          `Vehicle type '${typeStr}' not in allowed list [${allowed.join(', ')}]`,
          {
            op: 'includes',
            leftLabel: 'vehicleType',
            leftValue: typeStr,
            rightLabel: 'allowedVehicleTypes',
            rightValue: allowed,
          }
        );
        if (res) return res;
      }
    }

    // ── Distance (km) ─────────────────────────────────────────────
    const minDistance = filters.minDistance;
    const maxDistance = filters.maxDistance;
    const hasMinDistance = typeof minDistance === 'number' && minDistance > 0;
    // A max at (or above) the admin slider's top position means "no limit", not a 5000 km cap.
    const hasMaxDistance = typeof maxDistance === 'number' && maxDistance < DISTANCE_UNBOUNDED_KM;
    if (hasMinDistance || hasMaxDistance) {
      const distanceKm = getOfferDistanceKm(offer);
      if (distanceKm == null) {
        // Deliberately PERMISSIVE where rideType is strict: distance_km only exists when the
        // offer carries both sets of coordinates, which most offers do not. Rejecting on a
        // missing field here would silently stop the bot from accepting anything.
        traceCompare({
          offerId,
          filterName: 'distance_present',
          op: 'skip-when-unknown',
          leftLabel: 'distance_km',
          leftValue: distanceKm,
          rightLabel: 'action',
          rightValue: 'accept (unknown distance is not a rejection)',
          passed: true,
        });
      } else {
        if (hasMinDistance) {
          const passedMinDistance = distanceKm >= minDistance;
          traceCompare({
            offerId,
            filterName: 'minDistance',
            op: '>=',
            leftLabel: 'distanceKm',
            leftValue: distanceKm,
            rightLabel: 'minDistance',
            rightValue: minDistance,
            passed: passedMinDistance,
          });
          if (!passedMinDistance) {
            const res = fail(
              'minDistance',
              `Distance too short (${distanceKm}km < min ${minDistance}km)`,
              {
                op: '>=',
                leftLabel: 'distanceKm',
                leftValue: distanceKm,
                rightLabel: 'minDistance',
                rightValue: minDistance,
              }
            );
            if (res) return res;
          }
        }
        if (hasMaxDistance) {
          const passedMaxDistance = distanceKm <= maxDistance;
          traceCompare({
            offerId,
            filterName: 'maxDistance',
            op: '<=',
            leftLabel: 'distanceKm',
            leftValue: distanceKm,
            rightLabel: 'maxDistance',
            rightValue: maxDistance,
            passed: passedMaxDistance,
          });
          if (!passedMaxDistance) {
            const res = fail(
              'maxDistance',
              `Distance too long (${distanceKm}km > max ${maxDistance}km)`,
              {
                op: '<=',
                leftLabel: 'distanceKm',
                leftValue: distanceKm,
                rightLabel: 'maxDistance',
                rightValue: maxDistance,
              }
            );
            if (res) return res;
          }
        }
      }
    }

    // ── Ride type (transfer / hourly / both) ─────────────────────
    const rideTypeRaw = filters.rideType;
    const rideType =
      typeof rideTypeRaw === 'string' && rideTypeRaw.trim()
        ? rideTypeRaw.trim().toLowerCase()
        : '';
    if (rideType && rideType !== 'both') {
      const bookingTypeSource =
        typeof attrs?.booking_type === 'string' ? (attrs.booking_type as string) : '';
      const bookingType =
        bookingTypeSource && bookingTypeSource.trim()
          ? bookingTypeSource.trim().toLowerCase()
          : '';

      if (!bookingType) {
        const res = fail(
          'rideType',
          'Missing booking_type (required for rideType filter)',
          {
            op: '!= ""',
            leftLabel: 'booking_type',
            leftValue: bookingType,
            rightLabel: 'rideType',
            rightValue: rideType,
          }
        );
        if (res) return res;
      } else {
        const passedRideType = bookingType === rideType;
        traceCompare({
          offerId,
          filterName: 'rideType',
          op: '==',
          leftLabel: 'booking_type',
          leftValue: bookingType,
          rightLabel: 'rideType',
          rightValue: rideType,
          passed: passedRideType,
        });
        if (!passedRideType) {
          const res = fail(
            'rideType',
            `Booking type '${bookingType}' not allowed (user only accepts '${rideType}')`,
            {
              op: '==',
              leftLabel: 'booking_type',
              leftValue: bookingType,
              rightLabel: 'rideType',
              rightValue: rideType,
            }
          );
          if (res) return res;
        }
      }
    }

    // ── Min lead hours ────────────────────────────────────────────
    const minHours = filters.minHoursFromNow;
    const offerStart = getOfferDate(offer);
    if (typeof minHours === 'number' && minHours > 0) {
      const nowUtc = Date.now();
      if (offerStart == null) {
        const res = fail(
          'minHoursFromNow_start',
          'Missing starts_at',
          {
            op: '!= null',
            leftLabel: 'offerStart',
            leftValue: offerStart,
            rightLabel: 'required',
            rightValue: true,
          }
        );
        if (res) return res;
      } else {
        traceCompare({
          offerId,
          filterName: 'minHoursFromNow_start',
          op: '!= null',
          leftLabel: 'offerStart',
          leftValue: offerStart,
          rightLabel: 'required',
          rightValue: true,
          passed: true,
        });
        const msDiff = offerStart.getTime() - nowUtc;
        const hoursFromNow = msDiff / (3600 * 1000);
        const passedLead = hoursFromNow >= minHours;
        traceCompare({
          offerId,
          filterName: 'minHoursFromNow',
          op: '>=',
          leftLabel: 'hoursFromNow',
          leftValue: hoursFromNow,
          rightLabel: 'minHoursFromNow',
          rightValue: minHours,
          passed: passedLead,
        });
        if (!passedLead) {
          const res = fail(
            'minHoursFromNow',
            `Too soon (starts in ${hoursFromNow.toFixed(1)}h, min ${minHours}h)`,
            {
              op: '>=',
              leftLabel: 'hoursFromNow',
              leftValue: hoursFromNow,
              rightLabel: 'minHoursFromNow',
              rightValue: minHours,
            }
          );
          if (res) return res;
        }
      }
    }

    // ── Max lead hours ────────────────────────────────────────────
    // Mirror of minHoursFromNow, so a chauffeur can say "at night, same-day jobs only".
    // A config where min > max can never match; that is the operator's choice, not an error,
    // so both checks simply run and the offer is rejected by whichever fires first.
    const maxHours = filters.maxHoursFromNow;
    if (typeof maxHours === 'number' && maxHours > 0) {
      const nowUtc = Date.now();
      if (offerStart == null) {
        const res = fail('maxHoursFromNow_start', 'Missing starts_at', {
          op: '!= null',
          leftLabel: 'offerStart',
          leftValue: offerStart,
          rightLabel: 'required',
          rightValue: true,
        });
        if (res) return res;
      } else {
        traceCompare({
          offerId,
          filterName: 'maxHoursFromNow_start',
          op: '!= null',
          leftLabel: 'offerStart',
          leftValue: offerStart,
          rightLabel: 'required',
          rightValue: true,
          passed: true,
        });
        const hoursFromNow = (offerStart.getTime() - nowUtc) / (3600 * 1000);
        const passedMaxLead = hoursFromNow <= maxHours;
        traceCompare({
          offerId,
          filterName: 'maxHoursFromNow',
          op: '<=',
          leftLabel: 'hoursFromNow',
          leftValue: hoursFromNow,
          rightLabel: 'maxHoursFromNow',
          rightValue: maxHours,
          passed: passedMaxLead,
        });
        if (!passedMaxLead) {
          const res = fail(
            'maxHoursFromNow',
            `Too far out (starts in ${hoursFromNow.toFixed(1)}h, max ${maxHours}h)`,
            {
              op: '<=',
              leftLabel: 'hoursFromNow',
              leftValue: hoursFromNow,
              rightLabel: 'maxHoursFromNow',
              rightValue: maxHours,
            }
          );
          if (res) return res;
        }
      }
    }

    // ── Blackout dates (by ride local date) ────────────────────────
    const blackoutDatesRaw = Array.isArray(filters.blackoutDates)
      ? (filters.blackoutDates as string[])
      : [];
    if (blackoutDatesRaw.length > 0) {
      const normalizedBlackouts = blackoutDatesRaw
        .map((d) => (typeof d === 'string' ? d.trim() : ''))
        .filter(Boolean);

      const startsAtRaw =
        (offer?.attributes as Record<string, unknown> | undefined)?.starts_at ??
        (offer as Record<string, unknown>).starts_at;

      let rideDate: Date | null = null;
      if (typeof startsAtRaw === 'string' && startsAtRaw.trim()) {
        const d = new Date(startsAtRaw.trim());
        if (!Number.isNaN(d.getTime())) {
          rideDate = d;
        }
      }

      if (!rideDate) {
        const res = fail('blackoutDates', 'Missing or invalid starts_at for blackoutDates filter', {
          op: 'parse-date',
          leftLabel: 'starts_at',
          leftValue: startsAtRaw,
          rightLabel: 'required',
          rightValue: true,
        });
        if (res) return res;
      } else {
        let localDateStr: string;
        try {
          const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezoneId || undefined,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          });
          localDateStr = formatter.format(rideDate);
        } catch {
          const fallback = new Date(rideDate.getTime());
          const year = fallback.getFullYear();
          const month = String(fallback.getMonth() + 1).padStart(2, '0');
          const day = String(fallback.getDate()).padStart(2, '0');
          localDateStr = `${year}-${month}-${day}`;
        }

        const passedBlackout = !normalizedBlackouts.includes(localDateStr);
        traceCompare({
          offerId,
          filterName: 'blackoutDates',
          op: 'not-in',
          leftLabel: 'rideLocalDate',
          leftValue: localDateStr,
          rightLabel: 'blackoutDates',
          rightValue: normalizedBlackouts,
          passed: passedBlackout,
        });

        if (!passedBlackout) {
          const res = fail(
            'blackoutDates',
            `Ride date ${localDateStr} is in blackout dates`,
            {
              op: 'not-in',
              leftLabel: 'rideLocalDate',
              leftValue: localDateStr,
              rightLabel: 'blackoutDates',
              rightValue: normalizedBlackouts,
            }
          );
          if (res) return res;
        }
      }
    }

    // ── Static time range for ride start ───────────────────────────
    const startsAtForWindow =
      (offer?.attributes as Record<string, unknown> | undefined)?.starts_at ??
      (offer as Record<string, unknown>).starts_at;
    let rideStartForWindow: Date | null = null;
    if (typeof startsAtForWindow === 'string' && startsAtForWindow.trim()) {
      const d = new Date(startsAtForWindow.trim());
      if (!Number.isNaN(d.getTime())) {
        rideStartForWindow = d;
      }
    }

    const hasStartBound =
      typeof filters.allowedStartDate === 'string' && filters.allowedStartDate.trim().length > 0;
    const hasEndBound =
      typeof filters.allowedEndDate === 'string' && filters.allowedEndDate.trim().length > 0;

    if (hasStartBound || hasEndBound) {
      if (!rideStartForWindow) {
        const res = fail(
          'staticTimeRange',
          'Missing or invalid starts_at for staticTimeRange filter',
          {
            op: 'parse-date',
            leftLabel: 'starts_at',
            leftValue: startsAtForWindow,
            rightLabel: 'required',
            rightValue: true,
          }
        );
        if (res) return res;
      } else {
        if (hasStartBound) {
          const startBoundary = parseFilterBound(
            filters.allowedStartDate as string,
            'start',
            timezoneId
          );
          if (!startBoundary || Number.isNaN(startBoundary.getTime())) {
            const res = fail(
              'staticTimeRange',
              'Invalid allowedStartDate',
              {
                op: 'parse-date',
                leftLabel: 'allowedStartDate',
                leftValue: filters.allowedStartDate,
                rightLabel: 'validDate',
                rightValue: true,
              }
            );
            if (res) return res;
          } else {
            const passedStart = rideStartForWindow.getTime() >= startBoundary.getTime();
            traceCompare({
              offerId,
              filterName: 'staticTimeRange',
              op: '>=',
              leftLabel: 'rideStart',
              leftValue: rideStartForWindow,
              rightLabel: 'allowedStartDate',
              rightValue: startBoundary,
              passed: passedStart,
            });
            if (!passedStart) {
              const res = fail(
                'staticTimeRange',
                'Ride starts before allowedStartDate',
                {
                  op: '>=',
                  leftLabel: 'rideStart',
                  leftValue: rideStartForWindow,
                  rightLabel: 'allowedStartDate',
                  rightValue: startBoundary,
                }
              );
              if (res) return res;
            }
          }
        }

        if (hasEndBound) {
          const endBoundary = parseFilterBound(filters.allowedEndDate as string, 'end', timezoneId);
          if (!endBoundary || Number.isNaN(endBoundary.getTime())) {
            const res = fail(
              'staticTimeRange',
              'Invalid allowedEndDate',
              {
                op: 'parse-date',
                leftLabel: 'allowedEndDate',
                leftValue: filters.allowedEndDate,
                rightLabel: 'validDate',
                rightValue: true,
              }
            );
            if (res) return res;
          } else {
            const passedEnd = rideStartForWindow.getTime() <= endBoundary.getTime();
            traceCompare({
              offerId,
              filterName: 'staticTimeRange',
              op: '<=',
              leftLabel: 'rideStart',
              leftValue: rideStartForWindow,
              rightLabel: 'allowedEndDate',
              rightValue: endBoundary,
              passed: passedEnd,
            });
            if (!passedEnd) {
              const res = fail(
                'staticTimeRange',
                'Ride starts after allowedEndDate',
                {
                  op: '<=',
                  leftLabel: 'rideStart',
                  leftValue: rideStartForWindow,
                  rightLabel: 'allowedEndDate',
                  rightValue: endBoundary,
                }
              );
              if (res) return res;
            }
          }
        }
      }
    }

    // ── Working hours for offer start time ────────────────────────
    if (offerStart != null) {
      const startHour = filters.workingHoursStart;
      const endHour = filters.workingHoursEnd;
      if (typeof startHour === 'number' && typeof endHour === 'number') {
        let offerLocalHour = offerStart.getHours();
        if (timezoneId && timezoneId.trim()) {
          try {
            const formatter = new Intl.DateTimeFormat('en-CA', {
              timeZone: timezoneId.trim(),
              hour: '2-digit',
              hour12: false,
            });
            const hourStr = formatter.format(offerStart);
            const parsed = parseInt(hourStr, 10);
            if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 23) {
              offerLocalHour = parsed;
            }
          } catch {
            // fall back to server-local hour (offerStart.getHours())
          }
        }
        const insideWindow =
          startHour <= endHour
            ? offerLocalHour >= startHour && offerLocalHour < endHour
            : offerLocalHour >= startHour || offerLocalHour < endHour;

        traceCompare({
          offerId,
          filterName: 'workingHours_offerStart',
          op: 'inside-window',
          leftLabel: 'offerLocalHour',
          leftValue: offerLocalHour,
          rightLabel: 'window',
          rightValue: { startHour, endHour },
          passed: insideWindow,
        });

        if (!insideWindow) {
          const res = fail(
            'workingHours_offerStart',
            `Offer start hour ${offerLocalHour}:00 outside working window [${startHour}:00–${endHour}:00)`,
            {
              op: 'inside-window',
              leftLabel: 'offerLocalHour',
              leftValue: offerLocalHour,
              rightLabel: 'window',
              rightValue: { startHour, endHour },
            }
          );
          if (res) return res;
        }
      }
    }

    // ── Time-gap with existing rides ─────────────────────────────
    const minGap = filters.minGapMinutes;
    if (typeof minGap === 'number' && minGap > 0 && existingRides.length > 0) {
      if (offerStart == null) {
        const res = fail(
          'timeGap_start',
          'Missing starts_at (required for gap check)',
          {
            op: '!= null',
            leftLabel: 'offerStart',
            leftValue: offerStart,
            rightLabel: 'required',
            rightValue: true,
          }
        );
        if (res) return res;
      } else {
        const offerEnd = getOfferEndDate(offer, offerStart);
        if (offerEnd == null) {
          const res = fail(
            'timeGap_end',
            'Missing end time (required for gap check)',
            {
              op: '!= null',
              leftLabel: 'offerEnd',
              leftValue: offerEnd,
              rightLabel: 'required',
              rightValue: true,
            }
          );
          if (res) return res;
        } else {
          const gapMs = minGap * 60 * 1000;
          const hasConflict = checkTimeGap(offerStart, offerEnd, gapMs, existingRides);
          const passedGap = !hasConflict;
          traceCompare({
            offerId,
            filterName: 'timeGap',
            op: 'no-conflict',
            leftLabel: 'hasConflict',
            leftValue: hasConflict,
            rightLabel: 'expected',
            rightValue: false,
            passed: passedGap,
          });
          if (!passedGap) {
            const res = fail('timeGap', 'Schedule Conflict', {
              op: 'no-conflict',
              leftLabel: 'hasConflict',
              leftValue: hasConflict,
              rightLabel: 'expected',
              rightValue: false,
            });
            if (res) return res;
          }
        }
      }
    }

    // ── Location-based filters (airport & ZIP) ───────────────────
    const { pickup, dropoff } = resolveOfferLocations(offer, included);

    // Airport direction filter (pickup / dropoff / both)
    const allowedAirportDirections = Array.isArray(filters.allowedAirportDirections)
      ? (filters.allowedAirportDirections as string[])
      : undefined;
    if (allowedAirportDirections && allowedAirportDirections.length > 0) {
      const dirs = allowedAirportDirections
        .map((d) => (typeof d === 'string' ? d.trim().toLowerCase() : ''))
        .filter((d) => d === 'pickup' || d === 'dropoff');

      const pickupIsAirport = isAirportLocation(pickup);
      const dropoffIsAirport = isAirportLocation(dropoff);

      const pickupAllowed = !pickupIsAirport || dirs.includes('pickup');
      const dropoffAllowed = !dropoffIsAirport || dirs.includes('dropoff');
      const passedAirportDirection = pickupAllowed && dropoffAllowed;

      traceCompare({
        offerId,
        filterName: 'airportDirection',
        op: 'allowed-directions',
        leftLabel: 'legs',
        leftValue: { pickupIsAirport, dropoffIsAirport },
        rightLabel: 'allowedAirportDirections',
        rightValue: dirs,
        passed: passedAirportDirection,
      });

      if (!passedAirportDirection) {
        const reason = !pickupAllowed
          ? 'Pickup airport not allowed by airportDirection filter'
          : 'Dropoff airport not allowed by airportDirection filter';
        const res = fail('airportDirection', reason, {
          op: 'allowed-directions',
          leftLabel: 'legs',
          leftValue: { pickupIsAirport, dropoffIsAirport },
          rightLabel: 'allowedAirportDirections',
          rightValue: dirs,
        });
        if (res) return res;
      }
    }

    // Airline filter based on flight_number
    const allowedAirlines = Array.isArray(filters.allowedAirlines)
      ? (filters.allowedAirlines as string[])
      : undefined;
    const flightNumberRaw = attrs?.flight_number;
    const flightNumber =
      typeof flightNumberRaw === 'string' && flightNumberRaw.trim()
        ? flightNumberRaw.trim().toUpperCase()
        : '';

    if (flightNumber && allowedAirlines && allowedAirlines.length > 0) {
      const blockedUpper = allowedAirlines
        .map((c) => (typeof c === 'string' ? c.trim().toUpperCase() : ''))
        .filter((c) => c.length > 0);

      const isBlocked = blockedUpper.some(
        (code) => flightNumber.startsWith(code) || flightNumber.includes(code)
      );

      traceCompare({
        offerId,
        filterName: 'blockedAirlines',
        op: 'not-in-blocklist',
        leftLabel: 'flight_number',
        leftValue: flightNumber,
        rightLabel: 'blockedAirlines',
        rightValue: blockedUpper,
        passed: !isBlocked,
      });

      if (isBlocked) {
        const res = fail(
          'blockedAirlines',
          `Flight number '${flightNumber}' is blocked by airlines filter`,
          {
            op: 'in-blocklist',
            leftLabel: 'flight_number',
            leftValue: flightNumber,
            rightLabel: 'blockedAirlines',
            rightValue: blockedUpper,
          }
        );
        if (res) return res;
      }
    }

    // Pickup / dropoff city whitelists
    const pickupCity = getCity(pickup);
    const dropoffCity = getCity(dropoff);

    const allowedPickupCities = (filters.allowedPickupCities ?? [])
      .map((c) => normalizeCity(c))
      .filter(Boolean);
    if (allowedPickupCities.length > 0) {
      const pickupAllowed = allowedPickupCities.includes(pickupCity);
      traceCompare({
        offerId,
        filterName: 'allowedPickupCities',
        op: 'in-allowlist',
        leftLabel: 'pickupCity',
        leftValue: pickupCity,
        rightLabel: 'allowedPickupCities',
        rightValue: allowedPickupCities,
        passed: pickupAllowed,
      });
      if (!pickupAllowed) {
        const res = fail(
          'allowedPickupCities',
          `Pickup city '${pickupCity || 'unknown'}' is not in the allowed pickup cities`,
          {
            op: 'not-in-allowlist',
            leftLabel: 'pickupCity',
            leftValue: pickupCity,
            rightLabel: 'allowedPickupCities',
            rightValue: allowedPickupCities,
          }
        );
        if (res) return res;
      }
    }

    const allowedDropoffCities = (filters.allowedDropoffCities ?? [])
      .map((c) => normalizeCity(c))
      .filter(Boolean);
    if (allowedDropoffCities.length > 0) {
      const dropoffAllowed = allowedDropoffCities.includes(dropoffCity);
      traceCompare({
        offerId,
        filterName: 'allowedDropoffCities',
        op: 'in-allowlist',
        leftLabel: 'dropoffCity',
        leftValue: dropoffCity,
        rightLabel: 'allowedDropoffCities',
        rightValue: allowedDropoffCities,
        passed: dropoffAllowed,
      });
      if (!dropoffAllowed) {
        const res = fail(
          'allowedDropoffCities',
          `Dropoff city '${dropoffCity || 'unknown'}' is not in the allowed dropoff cities`,
          {
            op: 'not-in-allowlist',
            leftLabel: 'dropoffCity',
            leftValue: dropoffCity,
            rightLabel: 'allowedDropoffCities',
            rightValue: allowedDropoffCities,
          }
        );
        if (res) return res;
      }
    }

    if (useFullEval && failures.length > 0) {
      // In full-eval trace mode, at least one filter failed: return the first failure reason.
      return reject(failures[0]);
    }

    // ── All filters passed ───────────────────────────────────────
    return {
      match: true,
      reason: `Price ${price} & ${typeStr || 'any'}`,
    };
  }
}

// ── Internal helpers ───────────────────────────────────────────────

/** Build a rejection result and log it. */
function reject(reason: string): MatchResult {
  console.log(`[FILTER] Offer rejected: ${reason}`);
  return { match: false, reason };
}

/** Get the lowercase airport IATA code from an included location, or empty string. */
function getIata(loc: IncludedResource | null): string {
  const iata = loc?.attributes?.airport_iata;
  return typeof iata === 'string' && iata.trim() ? iata.trim().toLowerCase() : '';
}

function isAirportLocation(loc: IncludedResource | null): boolean {
  const tags = loc?.attributes?.tags;
  if (!Array.isArray(tags)) return false;
  for (const t of tags) {
    if (typeof t === 'string' && t.trim().toLowerCase() === 'airport') return true;
  }
  return false;
}

/** Get the lowercase formatted_address_en from an included location. */
function getFormattedAddress(loc: IncludedResource | null): string {
  const addr = loc?.attributes?.formatted_address_en;
  return typeof addr === 'string' ? addr.toLowerCase() : '';
}

/** Get the normalized city from an included location's `city` attribute, or empty string. */
function getCity(loc: IncludedResource | null): string {
  return normalizeCity(loc?.attributes?.city);
}

/**
 * Normalize a city name for forgiving comparison so cosmetic differences don't cause misses.
 * Lowercases, strips accents/diacritics, and removes everything that isn't a letter or digit
 * (spaces, hyphens, dots, apostrophes). So "  Saint-Étienne ", "saint etienne", and
 * "saintetienne" all collapse to the same key "saintetienne".
 */
function normalizeCity(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ''); // drop spaces, hyphens, dots, apostrophes, etc.
}
