import { createClient } from './supabase/client';

export const supabase = createClient();

export interface LastMatch {
  at: string;
  offer_id: string;
  price: string | number;
}

export interface BotRow {
  id: string;
  user_id: string | null;
  name: string | null;
  email: string;
  status: string;
  filters: Record<string, unknown>;
  session: Record<string, unknown>;
  last_seen: string;
  created_at: string;
  last_match?: LastMatch | null;
}
