/**
 * Keeps the Supabase `rides` table in sync with Blacklane API (planned rides).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { BlacklaneApi } from './blacklane-api';
import type { PlannedRide } from './blacklane-api';
import { logger } from '../utils';

export class RideSyncService {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly botId: string
  ) {}

  /**
   * Fetches planned rides from the API, upserts into the rides table,
   * and deletes rides where end_at is in the past.
   */
  async sync(api: BlacklaneApi): Promise<void> {
    const prefix = `[RideSync bot=${this.botId}]`;
    try {
      const planned = await api.getPlannedRides();

      const rows = planned.map((r: PlannedRide) => ({
        bot_id: this.botId,
        id: r.id,
        start_at: r.start_at.toISOString(),
        end_at: r.end_at.toISOString(),
        status: r.status,
        pickup: '',
        dropoff: '',
        updated_at: new Date().toISOString(),
      }));

      if (rows.length > 0) {
        const { error: upsertErr } = await this.supabase.from('rides').upsert(rows, {
          onConflict: 'bot_id,id',
          ignoreDuplicates: false,
        });
        if (upsertErr) {
          logger.warn(`${prefix} Upsert rides failed: ${upsertErr.message}`);
          return;
        }
      } else {
        const { error: delErr } = await this.supabase
          .from('rides')
          .delete()
          .eq('bot_id', this.botId);
        if (delErr) logger.warn(`${prefix} Delete all rides failed: ${delErr.message}`);
      }

      const nowIso = new Date().toISOString();
      const { error: cleanupErr } = await this.supabase
        .from('rides')
        .delete()
        .eq('bot_id', this.botId)
        .lt('end_at', nowIso);
      if (cleanupErr) logger.warn(`${prefix} Cleanup past rides failed: ${cleanupErr.message}`);

      logger.info(`${prefix} 📅 Synced ${planned.length} planned rides.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`${prefix} Sync failed: ${msg}`);
    }
  }
}
