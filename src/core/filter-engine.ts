/**
 * In-memory filter: decides if an offer is worth taking. No DB queries in hot loop.
 */

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
  [key: string]: unknown;
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
   */
  static isMatch(
    offer: OfferShape,
    filters: BotFilters,
    existingRides: ExistingRide[] = []
  ): MatchResult {
    const price = getOfferPrice(offer);
    const attrs = offer?.attributes as Record<string, unknown> | undefined;
    const vehicleType = (attrs?.service_class ?? offer?.vehicle_type) as string | undefined;
    const typeStr = typeof vehicleType === 'string' ? vehicleType.trim() : '';

    if (price == null) {
      return { match: false, reason: 'Missing price' };
    }
    if (price < filters.minPrice) {
      return { match: false, reason: 'Price too low' };
    }
    if (typeof filters.maxPrice === 'number' && price > filters.maxPrice) {
      return { match: false, reason: 'Price too high' };
    }

    const allowed = filters.allowedVehicleTypes ?? [];
    if (allowed.length > 0 && typeStr && !allowed.includes(typeStr)) {
      return {
        match: false,
        reason: 'Wrong vehicle',
      };
    }

    const minHours = filters.minHoursFromNow;
    const offerStart = getOfferDate(offer);
    if (typeof minHours === 'number' && minHours > 0) {
      const nowUtc = Date.now();
      if (offerStart == null) {
        return { match: false, reason: 'Missing starts_at' };
      }
      const msDiff = offerStart.getTime() - nowUtc;
      const hoursFromNow = msDiff / (3600 * 1000);
      if (hoursFromNow < minHours) {
        return {
          match: false,
          reason: `Too soon (starts in ${hoursFromNow.toFixed(1)}h, min ${minHours}h)`,
        };
      }
    }

    const minGap = filters.minGapMinutes;
    if (typeof minGap === 'number' && minGap > 0 && existingRides.length > 0) {
      if (offerStart == null) {
        return { match: false, reason: 'Missing starts_at (required for gap check)' };
      }
      const offerEnd = getOfferEndDate(offer, offerStart);
      if (offerEnd == null) {
        return { match: false, reason: 'Missing end time (required for gap check)' };
      }
      const gapMs = minGap * 60 * 1000;
      if (checkTimeGap(offerStart, offerEnd, gapMs, existingRides)) {
        return { match: false, reason: 'Schedule Conflict' };
      }
    }

    return {
      match: true,
      reason: `Price ${price} & ${typeStr || 'any'}`,
    };
  }
}
