/**
 * In-memory filter: decides if an offer is worth taking. No DB queries in hot loop.
 * New location-based filters use the JSON:API `included` array for pickup/dropoff resolution.
 */

import { isEnvFlagEnabled, logger } from '../utils';

const FILTER_TRACE_ENABLED = isEnvFlagEnabled(process.env.FILTER_TRACE);
const FILTER_TRACE_FULL_EVAL =
  FILTER_TRACE_ENABLED && isEnvFlagEnabled(process.env.FILTER_TRACE_FULL_EVAL);

export interface BotFilters {
  minPrice: number;
  /** Optional max price (offers above this are skipped). */
  maxPrice?: number;
  allowedVehicleTypes: string[];
  maxDistance?: number;
  /** Only match offers whose pickup/start (starts_at) is at least this many hours from now. */
  minHoursFromNow?: number;
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
          const startBoundary = new Date(filters.allowedStartDate as string);
          if (Number.isNaN(startBoundary.getTime())) {
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
          const endBoundary = new Date(filters.allowedEndDate as string);
          if (Number.isNaN(endBoundary.getTime())) {
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
