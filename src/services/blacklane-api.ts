/**
 * Raw HTTP client for Blacklane API. Uses keepAlive agent for low latency in sniper loop.
 */

import https from 'node:https';
import axios, { type AxiosInstance, type AxiosError } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { AuthCookie } from '../core/auth';
import { getOfferPrice } from '../core/filter-engine';
import { logger } from '../utils';
import crypto from 'node:crypto';

const BASE_URL = process.env.BLACKLANE_API_URL ?? '';
/** Request timeout in ms; default 15s to avoid ECONNABORTED when API or network is slow. */
const REQUEST_TIMEOUT_MS = Number(process.env.BLACKLANE_REQUEST_TIMEOUT_MS) || 15_000;

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
  const decodedUsername = url.username ? decodeURIComponent(url.username) : '';
  const rotatedUsername = decodedUsername.replace(
    /(session-)[A-Za-z0-9]+/,
    `$1${generateRandomSessionId()}`
  );
  if (rotatedUsername) {
    url.username = rotatedUsername;
  }
  return url.toString();
}

function getProxySessionLabelFromProxyUrl(proxyUrl: string): string | undefined {
  try {
    const url = new URL(proxyUrl);
    const username = url.username ? decodeURIComponent(url.username) : '';
    const match = username.match(/session-[A-Za-z0-9]+/);
    return match?.[0];
  } catch {
    return undefined;
  }
}

function createDirectAgent(): https.Agent {
  return new https.Agent({
    keepAlive: true,
    scheduling: 'fifo',
  });
}

function createProxyAgent(proxyUrl: string): https.Agent | undefined {
  try {
    const proxyAgent = new HttpsProxyAgent(proxyUrl);
    return proxyAgent as unknown as https.Agent;
  } catch (error) {
    logger.warn('Failed to create HTTPS proxy agent, falling back to direct HTTPS agent.', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Exact headers from a successful manual request (Chrome / partner portal).
 * Authorization and Cookie are set dynamically in setSession().
 */
function buildDefaultHeaders(userAgent: string): Record<string, string> {
  return {
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
    Origin: PARTNER_ORIGIN,
    Referer: `${PARTNER_ORIGIN}/`,
    'sec-ch-ua': '"Chromium";v="145", "Not:A-Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'x-requested-with': 'XMLHttpRequest',
  };
}

function createAxiosInstance(
  baseURL: string,
  agent: https.Agent,
  defaultHeaders: Record<string, string>
): AxiosInstance {
  return axios.create({
    baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    httpsAgent: agent,
    headers: defaultHeaders,
  });
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
  'page[size]': 50,
  include: 'pickup_location,dropoff_location',
  'filter[group]': 'planned',
};

const MAX_PLANNED_RIDES_PAGES = 10;

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
 * HTTP client for Blacklane API. Reuses TCP connections (keepAlive) for sniper loop performance.
 * Headers match successful manual request; Authorization is set dynamically in setSession().
 */
export class BlacklaneApi {
  private agent: https.Agent;
  private readonly client: AxiosInstance;
  private userAgent: string;
  /** Blacklane internal user id used for authenticated actions on partner portal. */
  private readonly blacklaneUserId: string;
  private readonly label: string;
  private baseProxyUrl: string;
  private currentProxyUrl: string;

  constructor(
    label: string,
    accessToken: string,
    cookies: AuthCookie[],
    userAgent: string,
    blacklaneUserId: string
  ) {
    if (!BASE_URL) {
      throw new Error('BLACKLANE_API_URL must be set');
    }
    this.label = label;
    this.userAgent = userAgent;
    this.blacklaneUserId = blacklaneUserId;
    this.baseProxyUrl = process.env.PROXY_URL?.trim() || '';
    this.currentProxyUrl = this.baseProxyUrl ? getDynamicProxyUrl(this.baseProxyUrl) : '';
    const proxyAgent = this.currentProxyUrl ? createProxyAgent(this.currentProxyUrl) : undefined;
    this.agent = proxyAgent ?? createDirectAgent();
    const defaultHeaders = buildDefaultHeaders(userAgent);
    this.client = createAxiosInstance(BASE_URL, this.agent, defaultHeaders);
    this.setSession(accessToken, cookies);
    this.client.interceptors.response.use(
      (res) => res,
      (err) => {
        const status = err.response?.status;
        if (status === 401) {
          return Promise.reject(new TokenExpiredError());
        }
        if (status === 429) {
          const retryAfter = err.response?.headers?.['retry-after'];
          return Promise.reject(
            new RateLimitError(undefined, retryAfter != null ? Number(retryAfter) : undefined)
          );
        }
        if (status === 502 || status === 503) {
          this.rotateProxySession('gateway');
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('ERR_TUNNEL_CONNECTION_FAILED') || msg.includes('ERR_PROXY_CONNECTION_FAILED')) {
            this.rotateProxySession('tunnel');
          }
        }
        return Promise.reject(err);
      }
    );
  }

  /**
   * Rotate proxy session locally (in-memory) for this API instance.
   * Never mutates process.env.PROXY_URL (safe for concurrent bots).
   */
  rotateProxySession(reason: 'gateway' | 'tunnel'): void {
    if (!this.baseProxyUrl) return;
    const nextProxyUrl = getDynamicProxyUrl(this.baseProxyUrl);
    const sessionLabel = getProxySessionLabelFromProxyUrl(nextProxyUrl);
    const nextAgent = createProxyAgent(nextProxyUrl);
    if (!nextAgent) return;

    // Best-effort: ensure we don't keep reusing pooled sockets from the previous agent.
    // HttpsProxyAgent extends http.Agent and supports destroy().
    try {
      (this.agent as unknown as { destroy?: () => void }).destroy?.();
    } catch {
      // ignore
    }

    this.currentProxyUrl = nextProxyUrl;
    this.agent = nextAgent;
    this.client.defaults.httpsAgent = this.agent;

    if (sessionLabel) {
      logger.warn(`[NETWORK] Rotated API proxy ${sessionLabel} for ${this.label} (reason=${reason})`);
    } else {
      logger.warn(`[NETWORK] Rotated API proxy for ${this.label} (reason=${reason})`);
    }
  }

  setSession(accessToken: string, cookies: AuthCookie[]): void {
    this.client.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
    this.client.defaults.headers.common['Cookie'] = buildCookieHeader(cookies);
  }

  /** GET /hades/offers with page and include params. Returns the response data. */
  async getOffers(): Promise<unknown> {
    const { data } = await this.client.get<unknown>('/hades/offers', { params: OFFERS_PARAMS });
    return data;
  }

  /**
   * GET /hades/bookings (scope=future). Returns upcoming booked rides for "My Rides" / Schedule.
   */
  async getUpcomingBookings(): Promise<UpcomingBooking[]> {
    const { data } = await this.client.get<unknown>('/hades/bookings', {
      params: UPCOMING_BOOKINGS_PARAMS,
    });
    return mapBookingsResponse(data);
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
      const response = await this.client.get<unknown>(
        nextUrl ?? '/hades/rides',
        nextUrl ? {} : { params: PLANNED_RIDES_PARAMS }
      );
      const body = response.data as Record<string, unknown> | undefined;
      const pageRides = mapPlannedRidesResponse(body);
      allRides.push(...pageRides);

      pageCount += 1;
      const links = body?.links as { next?: string | null } | undefined;
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
    const url = 'https://partner-portal-api.blacklane.com/chauffeur/offers';
    const priceFromFilter = getOfferPrice(offer);
    const cleanPrice =
      typeof priceFromFilter === 'number' && Number.isFinite(priceFromFilter) ? priceFromFilter : 0;
    const payload = {
      action: 'accept',
      id: offer?.id,
      price: cleanPrice,
    };

    const headers = {
      'blacklane-user-id': this.blacklaneUserId,
      'blacklane-user-roles': 'dispatcher,driver,provider',
      'content-type': 'application/json',
    };

    const isProduction = process.env.IS_PRODUCTION?.toLowerCase().trim() === 'true';
    if (!isProduction) {
      // Safety kill-switch: never hit the real endpoint outside production.
      logger.info(
        `[SIMULATION] Would send POST to ${url} with Payload: ${JSON.stringify(
          payload
        )} (cleanPrice: ${cleanPrice}) and Headers: ${JSON.stringify(headers)}`
      );
      return { status: 'simulation_success', offer_id: payload.id as string | undefined };
    }

    try {
      const { data } = await this.client.post<unknown>(url, payload, { headers });
      logger.info(
        `[PRODUCTION] Offer booked: id=${payload.id} price=${cleanPrice} — POST to ${url} succeeded.`
      );
      return data as { status: string; offer_id?: string } | Record<string, unknown>;
    } catch (error) {
      const err = error as AxiosError<any>;
      const status = err.response?.status;
      const code = (err.response?.data as { code?: string } | undefined)?.code;
      if (status === 410 && code === 'invalid_state') {
        logger.info(
          `[PRODUCTION] Offer ${payload.id} could not be accepted: invalid state (410). Probably already taken or no longer available.`
        );
        throw new InvalidOfferStateError(
          (err.response?.data as { detail?: string } | undefined)?.detail ??
            'Offer state is not valid (410)'
        );
      }
      throw error;
    }
  }
}
