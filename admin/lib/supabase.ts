import { createClient } from './supabase/client';

export const supabase = createClient();

export interface LastMatch {
  at: string;
  offer_id: string;
  price: string | number;
  /** Pickup/start time of the offer (ISO). */
  pickup_at?: string;
}

export interface BotRow {
  id: string;
  user_id: string | null;
  name: string | null;
  email: string;
  password?: string | null;
  status: string;
  filters: Record<string, unknown>;
  session: Record<string, unknown>;
  last_seen: string;
  created_at: string;
  last_match?: LastMatch | null;
  /** Blacklane internal user id used for authenticated API actions (e.g. accept offer). */
  blacklane_user_id?: string | null;
  /** IANA timezone for stealth (e.g. America/New_York) */
  timezone?: string | null;
  /** Locale for stealth (e.g. en-US) */
  locale?: string | null;
  /** Latitude for geo */
  latitude?: number | null;
  /** Longitude for geo */
  longitude?: number | null;
}

export interface RideRow {
  id: string;
  bot_id: string;
  start_at: string;
  end_at: string;
  status?: string | null;
  created_at?: string;
  updated_at?: string;
  pickup?: string | null;
  dropoff?: string | null;
  pickup_address?: string | null;
  dropoff_address?: string | null;
}

/** One row per accepted offer (dashboard Live Snipe Log). */
export interface AcceptedOfferRow {
  id: string;
  bot_id: string;
  offer_id: string;
  price?: string | null;
  pickup_at?: string | null;
  pickup_address?: string | null;
  dropoff_address?: string | null;
  created_at: string;
}
