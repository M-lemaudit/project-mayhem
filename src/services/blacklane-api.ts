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

/** Query params for GET /api/v1/chauffeur/offers */
const OFFERS_PARAMS = {
  sort_by: 'start_time',
  order_by: 'asc',
};

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
function normalizeNewApiResponse(raw: unknown): { data: unknown[]; included: unknown[] } {
  const response = raw as NewApiResponse | null;
  if (!response?.items || !Array.isArray(response.items)) {
    return { data: [], included: [] };
  }

  const data: unknown[] = [];
  const included: unknown[] = [];

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
        },
      });
    }

    if (ride?.dropOffLocation) {
      included.push({
        id: dropoffId,
        type: 'location',
        attributes: {
          airport_iata: (ride.dropOffLocation as NewApiLocation & { airportCode?: string }).airportCode ?? null,
          formatted_address_en: ride.dropOffLocation.address ?? ride.dropOffLocation.name ?? '',
          city: extractCityFromAddress(ride.dropOffLocation),
        },
      });
    }

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
      },
      relationships: {
        pickup_location: { data: { id: pickupId } },
        dropoff_location: { data: { id: dropoffId } },
      },
    });
  }

  return { data, included };
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

/** Planned ride returned by getPlannedRides() (times as Date). */
export interface PlannedRide {
  id: string;
  start_at: Date;
  end_at: Date;
  status: string;
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

  /** GET /api/v1/chauffeur/offers — partner-portal-api endpoint. Returns the response data. */
  async getOffers(): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: '*/*',
      'x-user-id': this.blacklaneUserId,
      'x-user-roles': 'dispatcher,driver,on_demand,provider',
    };
    if (this.bdId) headers['x-user-bd-id'] = this.bdId;
    if (this.lspId) headers['x-user-lsp-id'] = this.lspId;

    let lastError: unknown;
    for (let attempt = 1; attempt <= OFFERS_PROXY_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const client = await this.getAbsoluteClient();
        const response = await client.get<unknown>(OFFERS_URL, {
          searchParams: OFFERS_PARAMS,
          headers,
        });
        return normalizeNewApiResponse(response.body);
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
