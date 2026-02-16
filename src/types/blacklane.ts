/**
 * TypeScript interfaces for Blacklane API responses and bot configuration.
 */

/** Single offer from Blacklane API (e.g. GET /hades/offers). */
export interface BlacklaneOffer {
  id: string;
  price?: number;
  currency?: string;
  zone?: string;
  [key: string]: unknown;
}

/** Auth response containing access_token and optional cookies. */
export interface BlacklaneAuthResponse {
  access_token: string;
  expires_in?: number;
  token_type?: string;
  [key: string]: unknown;
}

/** Bot configuration (filters, credentials reference). Stored in Supabase bots table. */
export interface BotConfig {
  id: string;
  client_name: string;
  credentials: Record<string, string>;
  filters: OfferFilters;
  session_state?: SessionState | null;
  status: BotStatus;
}

export interface OfferFilters {
  min_price?: number;
  zones?: string[];
  blacklist?: string[];
  [key: string]: unknown;
}

export interface SessionState {
  access_token: string;
  cookies?: string;
  expires_at?: number;
  [key: string]: unknown;
}

export type BotStatus = 'RUNNING' | 'STOPPED' | 'ERROR' | 'ERROR_AUTH';
