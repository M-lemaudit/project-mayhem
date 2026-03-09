/**
 * Fetches global app settings from Supabase (shared by all bots).
 * Used for sniper delay bounds between requests.
 */

import { getSupabase } from './supabase';

const DEFAULT_DELAY_MIN_MS = 1000;
const DEFAULT_DELAY_MAX_MS = 3000;

export interface GlobalSettings {
  sniper_delay_min_ms: number;
  sniper_delay_max_ms: number;
}

/**
 * Returns delay bounds for the sniper loop. Random is applied in the loop between min and max.
 * On error or missing table, returns defaults.
 */
export async function getGlobalSettings(): Promise<GlobalSettings> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('global_settings')
      .select('sniper_delay_min_ms, sniper_delay_max_ms')
      .eq('id', 1)
      .maybeSingle();

    if (error || !data) {
      return { sniper_delay_min_ms: DEFAULT_DELAY_MIN_MS, sniper_delay_max_ms: DEFAULT_DELAY_MAX_MS };
    }

    const min = typeof data.sniper_delay_min_ms === 'number' ? data.sniper_delay_min_ms : DEFAULT_DELAY_MIN_MS;
    const max = typeof data.sniper_delay_max_ms === 'number' ? data.sniper_delay_max_ms : DEFAULT_DELAY_MAX_MS;
    const safeMin = Math.max(100, min);
    const safeMax = Math.max(safeMin, max);

    return { sniper_delay_min_ms: safeMin, sniper_delay_max_ms: safeMax };
  } catch {
    return { sniper_delay_min_ms: DEFAULT_DELAY_MIN_MS, sniper_delay_max_ms: DEFAULT_DELAY_MAX_MS };
  }
}
