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


/** Query params for GET /hades/offers (successful manual request). */
const OFFERS_PARAMS = {
  'page[number]': 1,
  'page[size]': 30,
  include: 'pickup_location,dropoff_location',
};

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
  /** Blacklane internal user id used for authenticated actions on partner portal. */
  private readonly blacklaneUserId: string;
  private readonly label: string;
  private baseProxyUrl: string;
  private currentProxyUrl: string;
  private accessToken: string;
  private cookies: AuthCookie[];

  constructor(
    label: string,
    accessToken: string,
    cookies: AuthCookie[],
    _userAgent: string,
    blacklaneUserId: string
  ) {
    if (!BASE_URL) {
      throw new Error('BLACKLANE_API_URL must be set');
    }
    this.label = label;
    this.blacklaneUserId = blacklaneUserId;
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

  private async getClient(): Promise<ScrapingClient> {
    if (this.client) return this.client;
    const { gotScraping } = await import('got-scraping');
    this.client = this.createGotClient(gotScraping as unknown as GotScrapingFactory);
    return this.client;
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

  /** GET /hades/offers with page and include params. Returns the response data. */
  async getOffers(): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= OFFERS_PROXY_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const { gotScraping } = await import('got-scraping');
        const client =
          this.client ??
          this.createGotClient(gotScraping as unknown as GotScrapingFactory);
        this.client = client;
        const response = await client.get<unknown>('hades/offers', { searchParams: OFFERS_PARAMS });
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
    let nextUrl: string | null = null;
    let pageCount = 0;

    do {
      let body: unknown;
      const requestTarget = this.getPathOrUrl(nextUrl ?? 'hades/rides');
      try {
        const client = await this.getClient();
        if (!nextUrl) {
          const firstPageTargets = Array.from(
            new Set<string>([requestTarget, ATHENA_HADES_RIDES_URL, PARTNER_HADES_RIDES_URL])
          );
          let firstPageError: unknown;
          let resolved = false;
          for (const target of firstPageTargets) {
            try {
              const response = await client.get<unknown>(target, {
                searchParams: PLANNED_RIDES_PARAMS,
              });
              body = response.body;
              resolved = true;
              break;
            } catch (firstErr) {
              firstPageError = firstErr;
              const status = this.getHttpStatus(firstErr);
              const canFallback = status === 404 && target !== firstPageTargets[firstPageTargets.length - 1];
              logger.warn(`[NETWORK] getPlannedRides first page attempt failed for ${this.label}`, {
                target,
                statusCode: status,
                canFallback,
              });
              if (canFallback) continue;
              throw firstErr;
            }
          }
          if (!resolved) throw firstPageError;
        } else {
          const response = await client.get<unknown>(requestTarget);
          body = response.body;
        }
      } catch (error) {
        logger.warn(`[NETWORK] getPlannedRides request failed for ${this.label}`, {
          requestTarget,
          pageCount: pageCount + 1,
          hasNextUrl: Boolean(nextUrl),
        });
        throw this.normalizeRequestError(error);
      }

      const bodyRecord = body as Record<string, unknown> | undefined;
      const pageRides = mapPlannedRidesResponse(bodyRecord);
      allRides.push(...pageRides);

      pageCount += 1;
      const links = bodyRecord?.links as { next?: string | null } | undefined;
      nextUrl = links?.next ?? null;
      if (nextUrl == null || nextUrl === '' || pageCount >= MAX_PLANNED_RIDES_PAGES) {
        break;
      }
    } while (true);

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
    const partnerUrl = 'https://partner-portal-api.blacklane.com/chauffeur/offers';
    const priceFromFilter = getOfferPrice(offer);
    const cleanPrice =
      typeof priceFromFilter === 'number' && Number.isFinite(priceFromFilter) ? priceFromFilter : 0;
    const offerId = typeof offer?.id === 'string' && offer.id.trim() ? offer.id.trim() : '';
    if (!offerId) {
      throw new Error('Cannot accept offer: missing offer.id');
    }
    const payload = {
      action: 'accept',
      id: offerId,
      price: cleanPrice,
    };

    const headers = {
      'blacklane-user-id': this.blacklaneUserId,
      'blacklane-user-roles': 'dispatcher,driver,provider',
      'content-type': 'application/json',
    };

    const isProduction = isEnvFlagEnabled(process.env.IS_PRODUCTION);
    if (!isProduction) {
      // Safety kill-switch: never hit the real endpoint outside production.
      logger.info(
        `[SIMULATION] Would send POST to ${partnerUrl} with Payload: ${JSON.stringify(
          payload
        )} (cleanPrice: ${cleanPrice}) and Headers: ${JSON.stringify(headers)}`
      );
      return { status: 'simulation_success', offer_id: payload.id as string | undefined };
    }

    try {
      const client = await this.getClient();
      const response = await client.post<unknown>(partnerUrl, { json: payload, headers });
      logger.info(
        `[PRODUCTION] Offer booked: id=${payload.id} price=${cleanPrice} — POST to ${partnerUrl} succeeded.`
      );
      return response.body as { status: string; offer_id?: string } | Record<string, unknown>;
    } catch (error) {
      const status = this.getHttpStatus(error);
      const parsedBody = this.parseErrorBody(error);
      const code = parsedBody?.code;
      if (status === 410 && code === 'invalid_state') {
        logger.info(
          `[PRODUCTION] Offer ${payload.id} could not be accepted: invalid state (410). Probably already taken or no longer available.`
        );
        throw new InvalidOfferStateError(parsedBody?.detail ?? 'Offer state is not valid (410)');
      }
      throw this.normalizeRequestError(error);
    }
  }
}
