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

/** Parse price from API: attributes.price (string "70.5") or root price/price_amount. Returns null if missing/invalid. */
function getOfferPrice(offer: OfferShape): number | null {
  const attrs = offer?.attributes as Record<string, unknown> | undefined;
  const raw =
    (attrs?.price != null ? attrs.price : undefined) ??
    offer?.price ??
    (offer?.price_amount != null ? offer.price_amount : undefined);
  if (raw == null) return null;
  if (typeof raw === 'number' && !Number.isNaN(raw)) return raw;
  if (typeof raw === 'string') {
    const n = parseFloat(raw.trim().replace(/,/g, '.'));
    if (!Number.isNaN(n)) return n;
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

export interface MatchResult {
  match: boolean;
  reason: string;
}

export class FilterEngine {
  /**
   * Returns whether the offer passes filters and a short reason.
   * Uses optional chaining so missing JSON fields do not crash.
   */
  static isMatch(offer: OfferShape, filters: BotFilters): MatchResult {
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
    if (typeof minHours === 'number' && minHours > 0) {
      const offerDate = getOfferDate(offer);
      const nowUtc = Date.now();
      if (offerDate == null) {
        return { match: false, reason: 'Missing starts_at' };
      }
      const msDiff = offerDate.getTime() - nowUtc;
      const hoursFromNow = msDiff / (3600 * 1000);
      if (hoursFromNow < minHours) {
        return {
          match: false,
          reason: `Too soon (starts in ${hoursFromNow.toFixed(1)}h, min ${minHours}h)`,
        };
      }
    }

    return {
      match: true,
      reason: `Price ${price} & ${typeStr || 'any'}`,
    };
  }
}
