/**
 * Raw HTTP client for Blacklane API. Uses keepAlive agent for low latency in sniper loop.
 */

import https from 'node:https';
import axios, { type AxiosInstance } from 'axios';
import type { AuthCookie } from '../core/auth';

const BASE_URL = process.env.BLACKLANE_API_URL ?? '';
const REQUEST_TIMEOUT_MS = 5_000;

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

/** Format Cookie header like browser: name=value; name2=value2 */
function buildCookieHeader(cookies: AuthCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function createAgent(): https.Agent {
  return new https.Agent({
    keepAlive: true,
    scheduling: 'fifo',
  });
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

/**
 * HTTP client for Blacklane API. Reuses TCP connections (keepAlive) for sniper loop performance.
 * Headers match successful manual request; Authorization is set dynamically in setSession().
 */
export class BlacklaneApi {
  private readonly agent: https.Agent;
  private readonly client: AxiosInstance;
  private userAgent: string;

  constructor(accessToken: string, cookies: AuthCookie[], userAgent: string) {
    if (!BASE_URL) {
      throw new Error('BLACKLANE_API_URL must be set');
    }
    this.userAgent = userAgent;
    this.agent = createAgent();
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
        return Promise.reject(err);
      }
    );
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
   * SIMULATION ONLY. Does not send any request to Blacklane.
   * Logs a warning and returns a mock success. Real POST is commented out.
   */
  async acceptOffer(offerId: string): Promise<{ status: string; offer_id: string }> {
    console.warn(`⚠️ SIMULATION MODE: Would have accepted offer ${offerId}`);
    // DO NOT uncomment: would trigger real acceptance on Blacklane.
    // const { data } = await this.client.post<unknown>(`/hades/offers/${encodeURIComponent(offerId)}/accept`);
    // return data;
    return { status: 'simulation_success', offer_id: offerId };
  }
}
