/**
 * Raw HTTP client for Blacklane API.
 */

import type { AuthCookie } from '../core/auth';
import { getOfferPrice } from '../core/filter-engine';
import { extractHttpStatusCode, isEnvFlagEnabled, logger } from '../utils';
import crypto from 'node:crypto';

type ScrapingClient = {
  get<T>(url: string, options?: Record<string, unknown>): Promise<{ body: T }>;
  post<T>(url: string, options?: Record<string, unknown>): Promise<{ body: T }>;
};

type GotScrapingFactory = {
  extend(options: Record<string, unknown>): ScrapingClient;
};

const BASE_URL = process.env.BLACKLANE_API_URL ?? '';
/** Request timeout in ms; default 15s to avoid ECONNABORTED when API or network is slow. */
const REQUEST_TIMEOUT_MS = Number(process.env.BLACKLANE_REQUEST_TIMEOUT_MS) || 15_000;
/** Retries for transient proxy/network failures while fetching offers. */
const OFFERS_PROXY_RETRY_ATTEMPTS = 3;

/** Origin/Referer for athena requests (same-site from partner portal). */
const PARTNER_ORIGIN = 'https://partner.blacklane.com';
const ACCEPT_DEBUG = process.env.ACCEPT_DEBUG?.trim().toLowerCase() === 'true';

/** Thrown when API returns 401; trigger re-auth. */
export class TokenExpiredError extends Error {
  constructor(message = 'Token expired or invalid (401)') {
    super(message);
    this.name = 'TokenExpiredError';
    Object.setPrototypeOf(this, TokenExpiredError.prototype);
  }
}

/** Thrown when API returns 429; use exponential backoff. */
export class RateLimitError extends Error {
  constructor(
    message = 'Rate limited (429)',
    public readonly retryAfter?: number
  ) {
    super(message);
    this.name = 'RateLimitError';
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/** Thrown when accepting an offer fails because its state is no longer valid (410 invalid_state). */
export class InvalidOfferStateError extends Error {
  constructor(message = 'Offer state is not valid (410)') {
    super(message);
    this.name = 'InvalidOfferStateError';
    Object.setPrototypeOf(this, InvalidOfferStateError.prototype);
  }
}

/** Format Cookie header like browser: name=value; name2=value2 */
function buildCookieHeader(cookies: AuthCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function generateRandomSessionId(length = 8): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const alphabetSize = alphabet.length;
  const maxUnbiased = Math.floor(256 / alphabetSize) * alphabetSize;

  let result = '';
  while (result.length < length) {
    const bytes = crypto.randomBytes(Math.max(16, length));
    for (const byte of bytes) {
      if (byte >= maxUnbiased) continue;
      result += alphabet[byte % alphabetSize];
      if (result.length >= length) break;
    }
  }
  return result;
}

function getDynamicProxyUrl(baseProxyUrl: string): string {
  const url = new URL(baseProxyUrl);
  const sessionRegex = /(session-)[A-Za-z0-9]+/;
  const decodedUsername = url.username ? decodeURIComponent(url.username) : '';
  const decodedPassword = url.password ? decodeURIComponent(url.password) : '';

  if (decodedUsername && sessionRegex.test(decodedUsername)) {
    url.username = decodedUsername.replace(sessionRegex, `$1${generateRandomSessionId()}`);
  } else if (decodedPassword && sessionRegex.test(decodedPassword)) {
    url.password = decodedPassword.replace(sessionRegex, `$1${generateRandomSessionId()}`);
  } else {
    return baseProxyUrl.replace(sessionRegex, `$1${generateRandomSessionId()}`);
  }
  return url.toString();
}

function getProxySessionLabelFromProxyUrl(proxyUrl: string): string | undefined {
  try {
    const url = new URL(proxyUrl);
    const username = url.username ? decodeURIComponent(url.username) : '';
    const password = url.password ? decodeURIComponent(url.password) : '';
    const match = (username + ' ' + password).match(/session-[A-Za-z0-9]+/);
    return match?.[0];
  } catch {
    return undefined;
  }
}

/**
 * Exact headers from a successful manual request (Chrome / partner portal).
 * Authorization and Cookie are set dynamically in setSession().
 */
function buildDefaultHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/json',
    Origin: PARTNER_ORIGIN,
    Referer: `${PARTNER_ORIGIN}/`,
    'x-requested-with': 'XMLHttpRequest',
  };
}


const OFFERS_URL = 'https://partner-portal-api.blacklane.com/api/v1/chauffeur/offers';

/** Sort key for GET /api/v1/chauffeur/offers (order is chosen per call, see below). */
const OFFERS_SORT_BY = 'start_time';

type OffersOrder = 'asc' | 'desc';
type OffersSortStrategy = 'alternate' | OffersOrder;

/**
 * The offers endpoint truncates its response to one page and never documented its page params.
 * Sorted `asc` only, we permanently see the soonest offers, so far-future ones (next month)
 * fall off the end of page 1 and are never even evaluated by the filter engine. Alternating the
 * order exposes the far end of the list on every other poll at zero extra request cost — the hot
 * loop polls continuously, so a far-future offer becomes visible within one extra cycle.
 */
function parseOffersSortStrategy(raw: string | undefined): OffersSortStrategy {
  const normalized = raw?.trim().replace(/^['"]+|['"]+$/g, '').toLowerCase() ?? '';
  if (normalized === 'asc' || normalized === 'desc' || normalized === 'alternate') return normalized;
  return 'alternate';
}

function parsePositiveInt(raw: string | undefined): number | null {
  const parsed = Number(raw?.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

const OFFERS_SORT_STRATEGY = parseOffersSortStrategy(process.env.OFFERS_SORT_STRATEGY);
/** Unset → no page-size param is sent at all (identical to previous behaviour). */
const OFFERS_PAGE_SIZE = parsePositiveInt(process.env.OFFERS_PAGE_SIZE);
/** Unset or 1 → exactly one request per getOffers() call, to keep hot-loop latency unchanged. */
const OFFERS_MAX_PAGES = parsePositiveInt(process.env.OFFERS_MAX_PAGES) ?? 1;
const OFFERS_TRACE_ENABLED = isEnvFlagEnabled(process.env.OFFERS_TRACE);

type OffersQueryParams = Record<string, string | number>;

/**
 * We cannot probe the live API for its real pagination param names, so every common spelling is
 * sent at once: unknown query params are ignored by virtually every API, and this costs nothing.
 */
function buildOffersParams(orderBy: OffersOrder, pageNumber?: number): OffersQueryParams {
  const params: OffersQueryParams = { sort_by: OFFERS_SORT_BY, order_by: orderBy };

  if (OFFERS_PAGE_SIZE != null) {
    params.per_page = OFFERS_PAGE_SIZE;
    params['page[size]'] = OFFERS_PAGE_SIZE;
    params.limit = OFFERS_PAGE_SIZE;
    params.page_size = OFFERS_PAGE_SIZE;
  }

  // Deliberately no bare `page=N`: Rack/Rails reject a request that mixes a scalar `page` with
  // `page[number]` on the same key (ParameterTypeError → 400), which would break the whole poll.
  if (pageNumber != null && pageNumber > 1) {
    params['page[number]'] = pageNumber;
    params.page_number = pageNumber;
  }

  return params;
}

// ── New API response normalization ────────────────────────────────────────────

interface NewApiLocation {
  name?: string;
  address?: string;
  airportCode?: string;
  longitude?: number;
  latitude?: number;
}

interface NewApiRide {
  type?: string;
  pickupTime?: string;
  flightNumber?: string;
  pickUpLocation?: NewApiLocation;
  dropOffLocation?: NewApiLocation;
  estimatedDurationMinutes?: number;
}

interface NewApiOffer {
  id?: string;
  type?: string;
  price?: number;
  price_minor_unit?: number;
  currency?: string;
  vehicleClass?: string;
  rides?: NewApiRide[];
}

interface NewApiResponse {
  items?: NewApiOffer[];
}

/** Location resource in the JSON:API-compatible shape FilterEngine consumes. */
interface NormalizedLocationResource {
  id: string;
  type: 'location';
  attributes: {
    airport_iata: string | null;
    formatted_address_en: string;
    city: string;
    /** FilterEngine.isAirportLocation() reads this; without it the airport-direction filter is dead. */
    tags: string[];
  };
}

/** Offer resource in the JSON:API-compatible shape FilterEngine consumes. */
interface NormalizedOfferResource {
  id: string;
  type: string;
  price?: number;
  vehicle_type?: string;
  attributes: {
    price?: number;
    currency?: string;
    service_class?: string;
    booking_type?: string;
    pickup_at?: string;
    starts_at?: string;
    flight_number?: string;
    duration?: number;
    /** Straight-line (great-circle) distance, NOT road distance. Absent when coords are missing. */
    distance_km?: number;
  };
  relationships: {
    pickup_location: { data: { id: string } };
    dropoff_location: { data: { id: string } };
  };
}

interface NormalizedOffersResponse {
  data: NormalizedOfferResource[];
  included: NormalizedLocationResource[];
}

const EARTH_RADIUS_KM = 6371;

function isValidLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

/** Great-circle distance in km between two WGS84 points (straight line, not road distance). */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  // clamp guards against float drift pushing sqrt(a) marginally above 1 for antipodal points
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Straight-line pickup→dropoff distance, rounded to 0.1 km. Undefined unless both coords are usable. */
function straightLineDistanceKm(
  from: NewApiLocation | undefined,
  to: NewApiLocation | undefined
): number | undefined {
  if (!from || !to) return undefined;
  if (!isValidLatitude(from.latitude) || !isValidLongitude(from.longitude)) return undefined;
  if (!isValidLatitude(to.latitude) || !isValidLongitude(to.longitude)) return undefined;
  return Math.round(haversineKm(from.latitude, from.longitude, to.latitude, to.longitude) * 10) / 10;
}

/** An airportCode is the only airport signal the new API gives us. */
function buildLocationTags(loc: NewApiLocation): string[] {
  return typeof loc.airportCode === 'string' && loc.airportCode.trim() !== '' ? ['airport'] : [];
}

function extractCityFromAddress(loc: NewApiLocation): string {
  // Address format: "Hotel Name, Street 123, 33480 Palm Beach, Florida"
  // Try to capture the word(s) after the zip code
  const address = loc.address ?? '';
  const zipMatch = address.match(/\d{4,5}\s+([^,]+)/);
  if (zipMatch) return zipMatch[1].trim();
  return loc.name ?? '';
}

/**
 * Converts the new /api/v1/chauffeur/offers response into the JSON:API-compatible
 * shape that FilterEngine expects: { data: OfferShape[], included: LocationResource[] }.
 */
function normalizeNewApiResponse(raw: unknown): NormalizedOffersResponse {
  const response = raw as NewApiResponse | null;
  if (!response?.items || !Array.isArray(response.items)) {
    return { data: [], included: [] };
  }

  const data: NormalizedOfferResource[] = [];
  const included: NormalizedLocationResource[] = [];

  for (const item of response.items) {
    if (!item?.id) continue;
    const ride = item.rides?.[0];

    const pickupId = `${item.id}_pickup`;
    const dropoffId = `${item.id}_dropoff`;

    if (ride?.pickUpLocation) {
      included.push({
        id: pickupId,
        type: 'location',
        attributes: {
          airport_iata: ride.pickUpLocation.airportCode ?? null,
          formatted_address_en: ride.pickUpLocation.address ?? ride.pickUpLocation.name ?? '',
          city: extractCityFromAddress(ride.pickUpLocation),
          tags: buildLocationTags(ride.pickUpLocation),
        },
      });
    }

    if (ride?.dropOffLocation) {
      included.push({
        id: dropoffId,
        type: 'location',
        attributes: {
          airport_iata: ride.dropOffLocation.airportCode ?? null,
          formatted_address_en: ride.dropOffLocation.address ?? ride.dropOffLocation.name ?? '',
          city: extractCityFromAddress(ride.dropOffLocation),
          tags: buildLocationTags(ride.dropOffLocation),
        },
      });
    }

    // Straight-line distance, not road distance — only usable as a rough proximity signal.
    const distanceKm = straightLineDistanceKm(ride?.pickUpLocation, ride?.dropOffLocation);

    data.push({
      id: item.id,
      type: item.type ?? 'ride',
      price: item.price,
      vehicle_type: item.vehicleClass,
      attributes: {
        price: item.price,
        currency: item.currency,
        service_class: item.vehicleClass,
        booking_type: ride?.type,
        pickup_at: ride?.pickupTime,
        starts_at: ride?.pickupTime,
        flight_number: ride?.flightNumber,
        duration: ride?.estimatedDurationMinutes,
        ...(distanceKm != null ? { distance_km: distanceKm } : {}),
      },
      relationships: {
        pickup_location: { data: { id: pickupId } },
        dropoff_location: { data: { id: dropoffId } },
      },
    });
  }

  return { data, included };
}

/** Top-level envelope keys of the raw offers response — the only clue to its real pagination shape. */
function extractEnvelopeKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) return [];
  return Object.keys(raw as Record<string, unknown>);
}

/** Earliest/furthest pickup instant in a normalized batch — the metric that proves the truncation. */
function summarizePickupWindow(offers: NormalizedOfferResource[]): {
  earliestPickupAt: string | null;
  furthestPickupAt: string | null;
} {
  let earliest: number | null = null;
  let furthest: number | null = null;

  for (const offer of offers) {
    const parsed = parseToDate(offer.attributes.pickup_at);
    if (!parsed) continue;
    const time = parsed.getTime();
    if (earliest == null || time < earliest) earliest = time;
    if (furthest == null || time > furthest) furthest = time;
  }

  return {
    earliestPickupAt: earliest == null ? null : new Date(earliest).toISOString(),
    furthestPickupAt: furthest == null ? null : new Date(furthest).toISOString(),
  };
}

/** Query params for GET /hades/bookings (upcoming / My Rides). */
const UPCOMING_BOOKINGS_PARAMS = {
  scope: 'future',
  include: 'pickup_location,dropoff_location',
};

/** Query params for GET /hades/rides (planned rides). */
const PLANNED_RIDES_PARAMS = {
  'page[number]': 1,
  // Keep this aligned with observed partner-portal request shape.
  'page[size]': 30,
  include:
    'pickup_location,dropoff_location,accepted_by,assigned_driver,assigned_vehicle,available_drivers,available_vehicles,status_updates',
  'filter[group]': 'planned',
};

const MAX_PLANNED_RIDES_PAGES = Number(process.env.BLACKLANE_MAX_PLANNED_RIDES_PAGES) || 50;
const ATHENA_HADES_RIDES_URL = 'https://athena.blacklane.com/hades/rides';
const PARTNER_HADES_RIDES_URL = 'https://partner-portal-api.blacklane.com/hades/rides';

/** Query params for GET /hades/finished_rides (billing reconciliation source of truth). */
const FINISHED_RIDES_PARAMS = {
  'page[number]': 1,
  'page[size]': 30,
  include:
    'pickup_location,dropoff_location,assigned_driver,assigned_vehicle,review,accepted_by,status_updates',
  // no_show still pays the driver, so it counts as a completed (billable) ride.
  'filter[status]': 'finished,no_show',
};

const MAX_FINISHED_RIDES_PAGES = Number(process.env.BLACKLANE_MAX_FINISHED_RIDES_PAGES) || 50;
const ATHENA_HADES_FINISHED_RIDES_URL = 'https://athena.blacklane.com/hades/finished_rides';
const PARTNER_HADES_FINISHED_RIDES_URL =
  'https://partner-portal-api.blacklane.com/hades/finished_rides';

/** Planned ride returned by getPlannedRides() (times as Date). */
export interface PlannedRide {
  id: string;
  start_at: Date;
  end_at: Date;
  status: string;
}

/**
 * A completed ride from GET /hades/finished_rides. Used by billing reconciliation to
 * determine which bot-booked offers were actually driven (status finished | no_show).
 */
export interface FinishedRide {
  rideUuid: string; // data[].id (athena ride uuid — distinct from the partner-portal offer id)
  bookingNumber: string; // attributes.booking_number
  legacyId: number | null; // attributes.legacy_id
  status: string; // 'finished' | 'no_show'
  price: number; // attributes.price (string in payload) — authoritative billing base
  currency: string; // attributes.currency
  startsAt: Date; // attributes.starts_at (offset-aware ISO)
  acceptedAt: Date | null; // attributes.accepted_at
  passengerName: string; // display only
}

/** Clean shape for an upcoming booking returned by getUpcomingBookings(). */
export interface UpcomingBooking {
  id: string;
  start_at: string;
  end_at: string;
  status: string;
  pickup: string;
  dropoff: string;
}

type BookingResource = {
  id: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
};

function parseDateOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'number' && v > 0) return new Date(v).toISOString();
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function stringFromLocation(loc: unknown): string {
  if (loc == null) return '';
  if (typeof loc === 'string') return loc.trim();
  if (typeof loc === 'object' && loc !== null) {
    const o = loc as Record<string, unknown>;
    const addr = o.address ?? o.formatted_address ?? o.name ?? o.display_name;
    if (typeof addr === 'string') return addr.trim();
    if (o.latitude != null && o.longitude != null) return `${o.latitude}, ${o.longitude}`;
  }
  return '';
}

function mapBookingsResponse(data: unknown): UpcomingBooking[] {
  const raw = data as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return [];
  const list = Array.isArray(raw.data) ? raw.data : Array.isArray(raw.bookings) ? raw.bookings : [];
  const included = (raw.included as Record<string, unknown>[] | undefined) ?? [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const inc of included) {
    if (inc && typeof inc === 'object' && typeof (inc as { id?: string }).id === 'string') {
      byId.set((inc as { id: string }).id, inc as Record<string, unknown>);
    }
  }

  const out: UpcomingBooking[] = [];
  for (const item of list) {
    const res = item as BookingResource;
    if (!res || typeof res.id !== 'string') continue;
    const attrs = res.attributes ?? {};
    const startAt =
      parseDateOrNull(attrs.starts_at ?? attrs.start_at ?? attrs.pickup_at ?? attrs.scheduled_at) ??
      '';
    const endAtRaw = parseDateOrNull(attrs.end_at ?? attrs.ends_at ?? attrs.dropoff_at);
    const durationMin = typeof attrs.duration === 'number' ? attrs.duration : null;
    const endAt =
      endAtRaw ?? (startAt && durationMin != null ? addMinutesToIso(startAt, durationMin) : startAt);

    const pickupLoc = attrs.pickup_location ?? attrs.pickup_location_id;
    const dropoffLoc = attrs.dropoff_location ?? attrs.dropoff_location_id;
    const pickup =
      stringFromLocation(pickupLoc) ||
      (typeof attrs.pickup === 'string' ? attrs.pickup : '') ||
      resolveLocation(pickupLoc, byId);
    const dropoff =
      stringFromLocation(dropoffLoc) ||
      (typeof attrs.dropoff === 'string' ? attrs.dropoff : '') ||
      resolveLocation(dropoffLoc, byId);

    const status = typeof attrs.status === 'string' ? attrs.status : 'unknown';

    out.push({
      id: res.id,
      start_at: startAt,
      end_at: endAt,
      status,
      pickup: pickup || '—',
      dropoff: dropoff || '—',
    });
  }
  return out;
}

function addMinutesToIso(iso: string, minutes: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

function resolveLocation(
  ref: unknown,
  byId: Map<string, Record<string, unknown>>
): string {
  if (ref == null) return '';
  if (typeof ref === 'object' && ref !== null && typeof (ref as { id?: string }).id === 'string') {
    const resolved = byId.get((ref as { id: string }).id);
    if (resolved) return stringFromLocation(resolved.attributes ?? resolved);
  }
  return stringFromLocation(ref);
}

function parseToDate(v: unknown): Date | null {
  if (v == null) return null;
  if (typeof v === 'number' && v > 0) return new Date(v);
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Parse JSON:API response for GET /hades/rides (filter[group]=planned).
 * Returns PlannedRide[] with start_at/end_at as Date. If ends_at missing, uses start_at + duration (minutes).
 */
function mapPlannedRidesResponse(data: unknown): PlannedRide[] {
  try {
    const raw = data as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return [];
    const list = Array.isArray(raw.data) ? raw.data : Array.isArray(raw.rides) ? raw.rides : [];
    const out: PlannedRide[] = [];
    for (const item of list) {
      try {
        const res = item as { id?: string; attributes?: Record<string, unknown> };
        if (!res || typeof res.id !== 'string') continue;
        const attrs = res.attributes ?? {};
        const startAt =
          parseToDate(attrs.starts_at ?? attrs.start_at ?? attrs.pickup_at ?? attrs.scheduled_at);
        if (!startAt) continue;
        let endAt: Date | null = parseToDate(attrs.ends_at ?? attrs.end_at ?? attrs.dropoff_at);
        if (!endAt) {
          const duration = attrs.duration;
          if (typeof duration === 'number') {
            const durationMs = duration > 1000 ? duration * 1000 : duration * 60_000;
            endAt = new Date(startAt.getTime() + durationMs);
          } else {
            endAt = new Date(startAt.getTime());
          }
        }
        const status = typeof attrs.status === 'string' ? attrs.status : 'unknown';
        out.push({
          id: res.id,
          start_at: startAt,
          end_at: endAt,
          status,
        });
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Parse JSON:API response for GET /hades/finished_rides. Returns FinishedRide[].
 * Skips rows missing an id or a parseable starts_at (can't be reconciled without a pickup instant).
 */
function mapFinishedRidesResponse(data: unknown): FinishedRide[] {
  try {
    const raw = data as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return [];
    const list = Array.isArray(raw.data) ? raw.data : [];
    const out: FinishedRide[] = [];
    for (const item of list) {
      try {
        const res = item as { id?: string; attributes?: Record<string, unknown> };
        if (!res || typeof res.id !== 'string') continue;
        const attrs = res.attributes ?? {};
        const startsAt = parseToDate(attrs.starts_at);
        if (!startsAt) continue;
        const priceRaw = attrs.price;
        const price =
          typeof priceRaw === 'number'
            ? priceRaw
            : typeof priceRaw === 'string'
              ? Number(priceRaw)
              : NaN;
        const first =
          typeof attrs.passenger_first_name === 'string' ? attrs.passenger_first_name : '';
        const last = typeof attrs.passenger_last_name === 'string' ? attrs.passenger_last_name : '';
        out.push({
          rideUuid: res.id,
          bookingNumber:
            typeof attrs.booking_number === 'string' ? attrs.booking_number : String(attrs.booking_number ?? ''),
          legacyId: typeof attrs.legacy_id === 'number' ? attrs.legacy_id : null,
          status: typeof attrs.status === 'string' ? attrs.status : 'unknown',
          price: Number.isFinite(price) ? price : 0,
          currency: typeof attrs.currency === 'string' ? attrs.currency : '',
          startsAt,
          acceptedAt: parseToDate(attrs.accepted_at),
          passengerName: `${first} ${last}`.trim(),
        });
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * HTTP client for Blacklane API.
 * Headers match successful manual request; Authorization is set dynamically in setSession().
 */
export class BlacklaneApi {
  private client: ScrapingClient | null = null;
  private absoluteClient: ScrapingClient | null = null;
  /** Blacklane internal user id used for authenticated actions on partner portal. */
  private readonly blacklaneUserId: string;
  private readonly bdId?: string;
  private readonly lspId?: string;
  private readonly label: string;
  private readonly userAgent: string;
  private baseProxyUrl: string;
  private currentProxyUrl: string;
  private accessToken: string;
  private cookies: AuthCookie[];
  /** Drives the asc/desc rotation when OFFERS_SORT_STRATEGY=alternate. */
  private offersFetchCount = 0;
  /** Warn once per instance: repeating a page means the API ignored our page-number params. */
  private warnedOffersPaginationIgnored = false;

  constructor(
    label: string,
    accessToken: string,
    cookies: AuthCookie[],
    userAgent: string,
    blacklaneUserId: string,
    bdId?: string,
    lspId?: string
  ) {
    if (!BASE_URL) {
      throw new Error('BLACKLANE_API_URL must be set');
    }
    this.label = label;
    this.blacklaneUserId = blacklaneUserId;
    this.bdId = bdId;
    this.lspId = lspId;
    this.userAgent = userAgent;
    this.accessToken = accessToken;
    this.cookies = cookies;
    this.baseProxyUrl = process.env.PROXY_URL?.trim() || '';
    this.currentProxyUrl = this.baseProxyUrl ? getDynamicProxyUrl(this.baseProxyUrl) : '';
  }

  private createGotClient(gotScraping: GotScrapingFactory): ScrapingClient {
    return gotScraping.extend({
      prefixUrl: BASE_URL,
      timeout: { request: REQUEST_TIMEOUT_MS },
      responseType: 'json',
      throwHttpErrors: true,
      retry: { limit: 0 },
      proxyUrl: this.currentProxyUrl || undefined,
      headerGeneratorOptions: {
        browsers: [{ name: 'chrome', minVersion: 120 }],
        os: ['windows'],
        devices: ['desktop'],
      },
      headers: {
        ...buildDefaultHeaders(),
        Authorization: `Bearer ${this.accessToken}`,
        Cookie: buildCookieHeader(this.cookies),
      },
    });
  }

  private createAbsoluteGotClient(gotScraping: GotScrapingFactory): ScrapingClient {
    return gotScraping.extend({
      timeout: { request: REQUEST_TIMEOUT_MS },
      responseType: 'json',
      throwHttpErrors: true,
      retry: { limit: 0 },
      proxyUrl: this.currentProxyUrl || undefined,
      headerGeneratorOptions: {
        browsers: [{ name: 'chrome', minVersion: 120 }],
        os: ['windows'],
        devices: ['desktop'],
      },
      headers: {
        ...buildDefaultHeaders(),
        Authorization: `Bearer ${this.accessToken}`,
        Cookie: buildCookieHeader(this.cookies),
      },
    });
  }

  private async getClient(): Promise<ScrapingClient> {
    if (this.client) return this.client;
    const { gotScraping } = await import('got-scraping');
    this.client = this.createGotClient(gotScraping as unknown as GotScrapingFactory);
    return this.client;
  }

  private async getAbsoluteClient(): Promise<ScrapingClient> {
    if (this.absoluteClient) return this.absoluteClient;
    const { gotScraping } = await import('got-scraping');
    this.absoluteClient = this.createAbsoluteGotClient(gotScraping as unknown as GotScrapingFactory);
    return this.absoluteClient;
  }

  /**
   * Rotate proxy session locally (in-memory) for this API instance.
   * Never mutates process.env.PROXY_URL (safe for concurrent bots).
   */
  rotateProxySession(reason: 'gateway' | 'tunnel'): void {
    if (!this.baseProxyUrl) return;
    const nextProxyUrl = getDynamicProxyUrl(this.baseProxyUrl);
    const sessionLabel = getProxySessionLabelFromProxyUrl(nextProxyUrl);
    this.currentProxyUrl = nextProxyUrl;
    this.client = null;
    this.absoluteClient = null;

    if (sessionLabel) {
      logger.warn(
        `[NETWORK] Rotated API proxy ${sessionLabel} for ${this.label} (reason=${reason}) — ${nextProxyUrl}`
      );
    } else {
      logger.warn(`[NETWORK] Rotated API proxy for ${this.label} (reason=${reason}) — ${nextProxyUrl}`);
    }
  }

  setSession(accessToken: string, cookies: AuthCookie[]): void {
    this.accessToken = accessToken;
    this.cookies = cookies;
    this.client = null;
    this.absoluteClient = null;
  }

  private shouldRetryWithProxyRotation(error: unknown): boolean {
    const status = this.getHttpStatus(error) ?? extractHttpStatusCode(error);
    if (status === 401 || status === 429) return false;
    if (status === 502 || status === 503 || status === 504) return true;

    const err = error as Error | undefined;
    const maybeCode = (error as { code?: unknown } | undefined)?.code;
    const code = typeof maybeCode === 'string' ? maybeCode : '';
    const message = err instanceof Error ? err.message : String(err ?? '');
    const normalized = `${code} ${message}`.toUpperCase();

    return (
      normalized.includes('ECONNRESET') ||
      normalized.includes('ECONNABORTED') ||
      normalized.includes('ETIMEDOUT') ||
      normalized.includes('EPIPE') ||
      normalized.includes('SOCKET HANG UP') ||
      normalized.includes('CLIENT NETWORK SOCKET DISCONNECTED BEFORE SECURE TLS CONNECTION WAS ESTABLISHED') ||
      normalized.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
      normalized.includes('ERR_PROXY_CONNECTION_FAILED')
    );
  }

  private getHttpStatus(error: unknown): number | undefined {
    if (typeof error !== 'object' || error == null) return undefined;
    const maybeResponse = (error as { response?: { statusCode?: unknown; status?: unknown } }).response;
    if (typeof maybeResponse?.statusCode === 'number') return maybeResponse.statusCode;
    if (typeof maybeResponse?.status === 'number') return maybeResponse.status;
    return undefined;
  }

  private getHeaderValue(error: unknown, headerName: string): string | undefined {
    if (typeof error !== 'object' || error == null) return undefined;
    const response = (error as { response?: { headers?: Record<string, unknown> } }).response;
    const headers = response?.headers;
    if (!headers || typeof headers !== 'object') return undefined;
    const normalizedKey = headerName.toLowerCase();
    const matchedKey = Object.keys(headers).find((k) => k.toLowerCase() === normalizedKey);
    const value = matchedKey ? headers[matchedKey] : undefined;
    if (Array.isArray(value)) return value[0] != null ? String(value[0]) : undefined;
    return value != null ? String(value) : undefined;
  }

  private parseErrorBody(error: unknown): { code?: string; detail?: string } | undefined {
    if (typeof error !== 'object' || error == null) return undefined;
    const responseBody = (error as { response?: { body?: unknown } }).response?.body;
    if (responseBody == null) return undefined;
    if (typeof responseBody === 'string') {
      try {
        return JSON.parse(responseBody) as { code?: string; detail?: string };
      } catch {
        return undefined;
      }
    }
    if (typeof responseBody === 'object') {
      return responseBody as { code?: string; detail?: string };
    }
    return undefined;
  }

  private getErrorDebugSnapshot(error: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (typeof error !== 'object' || error == null) return out;

    const err = error as {
      message?: unknown;
      code?: unknown;
      options?: { method?: unknown; url?: unknown; prefixUrl?: unknown; headers?: unknown };
      request?: { requestUrl?: unknown; options?: { method?: unknown; headers?: unknown } };
      response?: {
        statusCode?: unknown;
        statusMessage?: unknown;
        requestUrl?: unknown;
        headers?: unknown;
        body?: unknown;
      };
    };

    if (typeof err.message === 'string') out.errorMessage = err.message;
    if (typeof err.code === 'string') out.errorCode = err.code;
    if (err.options?.method != null) out.requestMethod = String(err.options.method);
    if (err.options?.url != null) out.requestUrlOption = String(err.options.url);
    if (err.options?.prefixUrl != null) out.requestPrefixUrl = String(err.options.prefixUrl);
    if (err.request?.requestUrl != null) out.requestUrl = String(err.request.requestUrl);
    if (err.response?.requestUrl != null) out.responseRequestUrl = String(err.response.requestUrl);
    if (typeof err.response?.statusCode === 'number') out.responseStatusCode = err.response.statusCode;
    if (typeof err.response?.statusMessage === 'string') out.responseStatusMessage = err.response.statusMessage;
    if (err.options?.headers && typeof err.options.headers === 'object') out.requestHeaders = err.options.headers;
    if (err.response?.headers && typeof err.response.headers === 'object') out.responseHeaders = err.response.headers;
    if (typeof err.response?.body === 'string') {
      out.responseBody = err.response.body.slice(0, 2_000);
    } else if (err.response?.body && typeof err.response.body === 'object') {
      out.responseBody = err.response.body;
    }

    return out;
  }

  private normalizeRequestError(error: unknown): Error {
    const status = this.getHttpStatus(error);
    if (status === 401) {
      return new TokenExpiredError();
    }
    if (status === 429) {
      const retryAfterRaw = this.getHeaderValue(error, 'retry-after');
      const retryAfter = retryAfterRaw != null ? Number(retryAfterRaw) : undefined;
      return new RateLimitError(undefined, Number.isFinite(retryAfter) ? retryAfter : undefined);
    }
    if (status === 502 || status === 503) {
      this.rotateProxySession('gateway');
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('ERR_TUNNEL_CONNECTION_FAILED') || msg.includes('ERR_PROXY_CONNECTION_FAILED')) {
        this.rotateProxySession('tunnel');
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /** Sort order for the next offers poll; alternates so both ends of the list stay visible. */
  private nextOffersOrderBy(): OffersOrder {
    if (OFFERS_SORT_STRATEGY !== 'alternate') return OFFERS_SORT_STRATEGY;
    this.offersFetchCount += 1;
    return this.offersFetchCount % 2 === 1 ? 'asc' : 'desc';
  }

  /** One offers request, with the existing transient proxy/network retry policy. Returns the raw body. */
  private async fetchOffersPage(
    headers: Record<string, string>,
    params: OffersQueryParams
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= OFFERS_PROXY_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const client = await this.getAbsoluteClient();
        const response = await client.get<unknown>(OFFERS_URL, {
          searchParams: params,
          headers,
        });
        return response.body;
      } catch (error) {
        const normalizedError = this.normalizeRequestError(error);
        lastError = normalizedError;
        const shouldRetry =
          this.shouldRetryWithProxyRotation(normalizedError) && attempt < OFFERS_PROXY_RETRY_ATTEMPTS;
        if (!shouldRetry) {
          throw normalizedError;
        }
        this.rotateProxySession('tunnel');
        logger.warn(
          `[NETWORK] getOffers transient network/proxy failure for ${this.label}; retrying with a rotated proxy (${attempt + 1}/${OFFERS_PROXY_RETRY_ATTEMPTS}).`
        );
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * GET /api/v1/chauffeur/offers — partner-portal-api endpoint. Returns the response data.
   * Issues exactly one request unless OFFERS_MAX_PAGES > 1 (hot-loop latency stays unchanged by default).
   */
  async getOffers(): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: '*/*',
      'x-user-id': this.blacklaneUserId,
      'x-user-roles': 'dispatcher,driver,on_demand,provider',
    };
    if (this.bdId) headers['x-user-bd-id'] = this.bdId;
    if (this.lspId) headers['x-user-lsp-id'] = this.lspId;

    const orderBy = this.nextOffersOrderBy();
    const firstBody = await this.fetchOffersPage(headers, buildOffersParams(orderBy));
    const merged = normalizeNewApiResponse(firstBody);
    const seenOfferIds = new Set<string>(merged.data.map((offer) => offer.id));
    let pagesFetched = 1;

    for (let pageNumber = 2; pageNumber <= OFFERS_MAX_PAGES; pageNumber += 1) {
      const pageBody = await this.fetchOffersPage(headers, buildOffersParams(orderBy, pageNumber));
      const page = normalizeNewApiResponse(pageBody);
      pagesFetched += 1;
      if (page.data.length === 0) break;

      const freshOffers = page.data.filter((offer) => !seenOfferIds.has(offer.id));
      if (freshOffers.length === 0) {
        // Every id repeated → the API ignored our page-number params and re-served page 1.
        if (!this.warnedOffersPaginationIgnored) {
          this.warnedOffersPaginationIgnored = true;
          logger.warn(
            `[OFFERS] Page ${pageNumber} repeated page 1 for ${this.label}; the API ignores our page-number params. Falling back to a single page (set OFFERS_MAX_PAGES=1).`
          );
        }
        break;
      }

      const freshLocationIds = new Set<string>();
      for (const offer of freshOffers) {
        seenOfferIds.add(offer.id);
        freshLocationIds.add(offer.relationships.pickup_location.data.id);
        freshLocationIds.add(offer.relationships.dropoff_location.data.id);
      }
      merged.data.push(...freshOffers);
      merged.included.push(...page.included.filter((loc) => freshLocationIds.has(loc.id)));
    }

    this.logOffersBatch(merged, orderBy, firstBody, pagesFetched);
    return merged;
  }

  /**
   * Cheap visibility on the pagination theory: the batch size and how far into the future it reaches.
   * OFFERS_TRACE additionally dumps the raw envelope keys, which are what reveal the real page shape.
   */
  private logOffersBatch(
    batch: NormalizedOffersResponse,
    orderBy: OffersOrder,
    firstBody: unknown,
    pagesFetched: number
  ): void {
    const { earliestPickupAt, furthestPickupAt } = summarizePickupWindow(batch.data);

    if (OFFERS_TRACE_ENABLED) {
      logger.info(`[OFFERS_TRACE] offers batch for ${this.label}`, {
        count: batch.data.length,
        orderBy,
        pagesFetched,
        earliestPickupAt,
        furthestPickupAt,
        envelopeKeys: extractEnvelopeKeys(firstBody),
      });
      return;
    }

    logger.debug(`[OFFERS] offers batch for ${this.label}`, {
      count: batch.data.length,
      orderBy,
      furthestPickupAt,
    });
  }

  /**
   * GET /hades/bookings (scope=future). Returns upcoming booked rides for "My Rides" / Schedule.
   */
  async getUpcomingBookings(): Promise<UpcomingBooking[]> {
    try {
      const client = await this.getClient();
      const response = await client.get<unknown>('hades/bookings', {
        searchParams: UPCOMING_BOOKINGS_PARAMS,
      });
      return mapBookingsResponse(response.body);
    } catch (error) {
      throw this.normalizeRequestError(error);
    }
  }

  private getPathOrUrl(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    return url.startsWith('/') ? url.slice(1) : url;
  }

  /**
   * GET /hades/rides with filter[group]=planned. Fetches all pages via response.links.next.
   * Max 10 pages (500 rides) to prevent infinite loops. Accept: application/vnd.api+json is set on the client.
   */
  async getPlannedRides(): Promise<PlannedRide[]> {
    const allRides: PlannedRide[] = [];
    const client = await this.getClient();
    const firstPageTargets = Array.from(
      new Set<string>(['hades/rides', ATHENA_HADES_RIDES_URL, PARTNER_HADES_RIDES_URL])
    );

    let selectedTarget: string | null = null;
    for (const target of firstPageTargets) {
      try {
        const response = await client.get<unknown>(target, {
          searchParams: PLANNED_RIDES_PARAMS,
        });
        const bodyRecord = response.body as Record<string, unknown> | undefined;
        const pageRides = mapPlannedRidesResponse(bodyRecord);
        allRides.push(...pageRides);
        selectedTarget = target;
        break;
      } catch (firstErr) {
        const status = this.getHttpStatus(firstErr);
        const canFallback = status === 404 && target !== firstPageTargets[firstPageTargets.length - 1];
        logger.warn(`[NETWORK] getPlannedRides first page attempt failed for ${this.label}`, {
          target,
          statusCode: status,
          canFallback,
        });
        if (!canFallback) {
          throw this.normalizeRequestError(firstErr);
        }
      }
    }

    if (!selectedTarget) {
      throw new Error('getPlannedRides: no reachable endpoint for first page');
    }

    // Manual page-number pagination to avoid unreliable links.next URLs (some return 404).
    for (let pageNumber = 2; pageNumber <= MAX_PLANNED_RIDES_PAGES; pageNumber += 1) {
      const params = {
        ...PLANNED_RIDES_PARAMS,
        'page[number]': pageNumber,
      };
      try {
        const response = await client.get<unknown>(selectedTarget, {
          searchParams: params,
        });
        const bodyRecord = response.body as Record<string, unknown> | undefined;
        const pageRides = mapPlannedRidesResponse(bodyRecord);
        if (pageRides.length === 0) break;
        allRides.push(...pageRides);
      } catch (error) {
        const status = this.getHttpStatus(error);
        logger.warn(`[NETWORK] getPlannedRides page request failed for ${this.label}`, {
          selectedTarget,
          pageNumber,
          statusCode: status,
        });
        throw this.normalizeRequestError(error);
      }
    }

    return allRides;
  }

  /**
   * GET /hades/finished_rides (filter[status]=finished,no_show) — completed rides, newest first.
   * Pages through results, stopping early once a page's oldest ride predates `stopBeforeMs`
   * (the rolling-window cutoff from the reconciler) so we never page the entire history.
   */
  async getFinishedRides(stopBeforeMs?: number): Promise<FinishedRide[]> {
    const allRides: FinishedRide[] = [];
    const client = await this.getClient();
    const targets = Array.from(
      new Set<string>([
        'hades/finished_rides',
        ATHENA_HADES_FINISHED_RIDES_URL,
        PARTNER_HADES_FINISHED_RIDES_URL,
      ])
    );

    // First page: pick the reachable endpoint (some accounts 404 on the relative path).
    let selectedTarget: string | null = null;
    for (const target of targets) {
      try {
        const response = await client.get<unknown>(target, { searchParams: FINISHED_RIDES_PARAMS });
        const pageRides = mapFinishedRidesResponse(response.body as Record<string, unknown>);
        allRides.push(...pageRides);
        selectedTarget = target;
        if (this.reachedWindowEnd(pageRides, stopBeforeMs)) return allRides;
        break;
      } catch (firstErr) {
        const status = this.getHttpStatus(firstErr);
        const canFallback = status === 404 && target !== targets[targets.length - 1];
        logger.warn(`[NETWORK] getFinishedRides first page attempt failed for ${this.label}`, {
          target,
          statusCode: status,
          canFallback,
        });
        if (!canFallback) throw this.normalizeRequestError(firstErr);
      }
    }

    if (!selectedTarget) {
      throw new Error('getFinishedRides: no reachable endpoint for first page');
    }

    for (let pageNumber = 2; pageNumber <= MAX_FINISHED_RIDES_PAGES; pageNumber += 1) {
      const params = { ...FINISHED_RIDES_PARAMS, 'page[number]': pageNumber };
      try {
        const response = await client.get<unknown>(selectedTarget, { searchParams: params });
        const pageRides = mapFinishedRidesResponse(response.body as Record<string, unknown>);
        if (pageRides.length === 0) break;
        allRides.push(...pageRides);
        if (this.reachedWindowEnd(pageRides, stopBeforeMs)) break;
      } catch (error) {
        logger.warn(`[NETWORK] getFinishedRides page request failed for ${this.label}`, {
          selectedTarget,
          pageNumber,
          statusCode: this.getHttpStatus(error),
        });
        throw this.normalizeRequestError(error);
      }
    }

    return allRides;
  }

  /** True once a page contains a ride at/older than the rolling-window cutoff (results are newest-first). */
  private reachedWindowEnd(pageRides: FinishedRide[], stopBeforeMs?: number): boolean {
    if (stopBeforeMs == null) return false;
    return pageRides.some((r) => r.startsAt.getTime() <= stopBeforeMs);
  }

  /**
   * Accept a Blacklane offer using the real partner-portal endpoint.
   *
   * In non-production (IS_PRODUCTION not exactly 'true', case-insensitive), this
   * method ONLY logs the request that would be sent and returns a mock success object.
   */
  async acceptOffer(
    offer: any
  ): Promise<{ status: string; offer_id?: string } | Record<string, unknown>> {
    const priceFromFilter = getOfferPrice(offer);
    const cleanPrice =
      typeof priceFromFilter === 'number' && Number.isFinite(priceFromFilter) ? priceFromFilter : 0;
    const offerId = typeof offer?.id === 'string' && offer.id.trim() ? offer.id.trim() : '';
    if (!offerId) {
      throw new Error('Cannot accept offer: missing offer.id');
    }

    const acceptUrl = `https://partner-portal-api.blacklane.com/api/v1/chauffeur/offers/${offerId}/acceptance`;

    const attrs = offer?.attributes as Record<string, unknown> | undefined;
    const currency = typeof attrs?.currency === 'string' ? attrs.currency : 'EUR';
    const bookingType = typeof attrs?.booking_type === 'string' ? attrs.booking_type : 'prebooked';
    const priceMinorUnit = Math.round(cleanPrice * 100);

    const payload = {
      currency,
      price: cleanPrice,
      price_minor_unit: priceMinorUnit,
      type: bookingType,
    };

    const headers: Record<string, string> = {
      accept: '*/*',
      'x-user-id': this.blacklaneUserId,
      'x-user-roles': 'dispatcher,driver,provider',
      'content-type': 'application/json',
      'x-user-agent': this.userAgent,
    };
    if (this.bdId) headers['x-user-bd-id'] = this.bdId;
    if (this.lspId) headers['x-user-lsp-id'] = this.lspId;

    const isProduction = isEnvFlagEnabled(process.env.IS_PRODUCTION);
    if (!isProduction) {
      logger.info(
        `[SIMULATION] Would send POST to ${acceptUrl} with Payload: ${JSON.stringify(
          payload
        )} and Headers: ${JSON.stringify(headers)}`
      );
      return { status: 'simulation_success', offer_id: offerId };
    }

    if (ACCEPT_DEBUG) {
      logger.info(`[ACCEPT_DEBUG] Sending accept request for ${this.label}`, {
        endpoint: acceptUrl,
        payload,
        headers,
      });
    }

    try {
      const client = await this.getAbsoluteClient();
      await client.post<unknown>(acceptUrl, { json: payload, headers });
      logger.info(
        `[PRODUCTION] Offer booked: id=${offerId} price=${cleanPrice} — POST to ${acceptUrl} succeeded.`
      );
      return { status: 'accepted', offer_id: offerId };
    } catch (error) {
      const status = this.getHttpStatus(error);
      const parsedBody = this.parseErrorBody(error);
      const code = parsedBody?.code;
      logger.warn(`[ACCEPT_DEBUG] Accept failed for ${this.label}`, {
        endpoint: acceptUrl,
        payload,
        statusCode: status,
        parsedBody,
        ...this.getErrorDebugSnapshot(error),
      });
      if (status === 410 && code === 'invalid_state') {
        logger.info(
          `[PRODUCTION] Offer ${offerId} could not be accepted: invalid state (410). Probably already taken or no longer available.`
        );
        throw new InvalidOfferStateError(parsedBody?.detail ?? 'Offer state is not valid (410)');
      }
      throw this.normalizeRequestError(error);
    }
  }
}
