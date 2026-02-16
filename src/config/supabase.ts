/**
 * Supabase client singleton. Initialized from process.env.
 * Use after dotenv is loaded (e.g. in index.ts).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client === null) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_KEY must be set');
    }
    client = createClient(url, key);
  }
  return client;
}

/** For tests or explicit teardown. */
export function resetSupabaseSingleton(): void {
  client = null;
}
