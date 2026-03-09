/**
 * Supabase client singleton for backend worker. Bypasses RLS when using service role.
 * Use after dotenv is loaded (e.g. in index.ts).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client === null) {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const anonKey = process.env.SUPABASE_KEY;

    if (!url) {
      throw new Error('SUPABASE_URL must be set');
    }

    if (serviceRoleKey) {
      client = createClient(url, serviceRoleKey);
      return client;
    }

    if (anonKey) {
      logger.warn(
        'SUPABASE_SERVICE_ROLE_KEY not set; using SUPABASE_KEY. RLS may block bot access to bots table.'
      );
      client = createClient(url, anonKey);
      return client;
    }

    throw new Error('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY must be set');
  }
  return client;
}

/** For tests or explicit teardown. */
export function resetSupabaseSingleton(): void {
  client = null;
}
