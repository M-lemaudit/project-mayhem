/**
 * Synchronizes local bot state with Supabase `bots` table.
 * Manages session persistence, filters, and status updates.
 * Uses getSupabase() singleton from config.
 */

import { getSupabase } from '../config/supabase';
import { logger } from '../utils';

export type BotStatus = 'RUNNING' | 'STOPPED' | 'ERROR_AUTH' | 'PAUSED_RATE_LIMIT' | 'SLEEPING';

export interface BotRow {
  id: string;
  email: string;
  /** Blacklane internal user id used for authenticated API actions (e.g. accept offer). */
  blacklane_user_id?: string | null;
  status: BotStatus;
  filters: Record<string, unknown>;
  session: Record<string, unknown>;
  last_seen: string;
  created_at: string;
}

export interface BotConfig {
  status: BotStatus;
  filters: Record<string, unknown>;
  session: Record<string, unknown>;
  /** Blacklane internal user id used for authenticated API actions (e.g. accept offer). */
  blacklaneUserId?: string | null;
}

export class BotStateService {
  constructor(private readonly email: string) {}

  /**
   * Ensures a row exists for this bot. Creates one with default status if missing.
   * Returns the current config.
   */
  async initialize(): Promise<BotConfig> {
    const supabase = getSupabase();

    const { data: existing, error: fetchError } = await supabase
      .from('bots')
      .select('id, status, filters, session, blacklane_user_id')
      .eq('email', this.email)
      .maybeSingle();

    if (fetchError) {
      throw new Error(`BotStateService.initialize: ${fetchError.message}`);
    }

    if (existing) {
      return {
        status: (existing.status as BotStatus) ?? 'STOPPED',
        filters: (existing.filters as Record<string, unknown>) ?? {},
        session: (existing.session as Record<string, unknown>) ?? {},
        blacklaneUserId:
          (existing as BotRow).blacklane_user_id != null
            ? String((existing as BotRow).blacklane_user_id)
            : undefined,
      };
    }

    const defaultFilters = { minPrice: 10 };
    const { data: inserted, error: insertError } = await supabase
      .from('bots')
      .insert({
        email: this.email,
        status: 'STOPPED',
        filters: defaultFilters,
        session: {},
      })
      .select('id, status, filters, session, blacklane_user_id')
      .single();

    if (insertError) {
      throw new Error(`BotStateService.initialize insert: ${insertError.message}`);
    }

    logger.info('Bot row created', { email: this.email, id: inserted.id });
    return {
      status: (inserted.status as BotStatus) ?? 'STOPPED',
      filters: (inserted.filters as Record<string, unknown>) ?? {},
      session: (inserted.session as Record<string, unknown>) ?? {},
      blacklaneUserId:
        (inserted as BotRow).blacklane_user_id != null
          ? String((inserted as BotRow).blacklane_user_id)
          : undefined,
    };
  }

  /** Persists session data (cookies, token, userAgent) to Supabase. */
  async saveSession(sessionData: Record<string, unknown>): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
      .from('bots')
      .update({
        session: sessionData,
        last_seen: new Date().toISOString(),
      })
      .eq('email', this.email);

    if (error) {
      throw new Error(`BotStateService.saveSession: ${error.message}`);
    }
    logger.info(`[${this.email}] 💾 Session saved to Supabase`);
  }

  /** Returns the stored session JSON. */
  async getSession(): Promise<Record<string, unknown>> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('bots')
      .select('session')
      .eq('email', this.email)
      .single();

    if (error) {
      throw new Error(`BotStateService.getSession: ${error.message}`);
    }
    return (data?.session as Record<string, unknown>) ?? {};
  }

  /** Updates last_seen column (heartbeat). */
  async updateHeartbeat(): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
      .from('bots')
      .update({ last_seen: new Date().toISOString() })
      .eq('email', this.email);

    if (error) {
      throw new Error(`BotStateService.updateHeartbeat: ${error.message}`);
    }
  }

  /** Updates the status column. */
  async updateStatus(status: string): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
      .from('bots')
      .update({
        status,
        last_seen: new Date().toISOString(),
      })
      .eq('email', this.email);

    if (error) {
      throw new Error(`BotStateService.updateStatus: ${error.message}`);
    }
    logger.info(`[${this.email}] Status updated`, { status });
  }

  /** Records a matching offer so the admin can show a notification (simulation mode). */
  async reportMatch(
    offerId: string,
    price: string | number,
    pickupAt?: string
  ): Promise<void> {
    const supabase = getSupabase();

    const lastMatch: Record<string, unknown> = {
      at: new Date().toISOString(),
      offer_id: offerId,
      price: typeof price === 'number' ? price : String(price),
    };
    if (pickupAt) lastMatch.pickup_at = pickupAt;

    const { error } = await supabase
      .from('bots')
      .update({
        last_match: lastMatch,
        last_seen: new Date().toISOString(),
      })
      .eq('email', this.email);

    if (error) {
      logger.warn(`[${this.email}] reportMatch failed:`, error.message);
    }
  }

  /**
   * Subscribes to Realtime UPDATE events on this bot's row.
   * When status changes to STOPPED, calls onStopRequested.
   * Returns unsubscribe function.
   */
  subscribeToRemoteStop(onStopRequested: () => void): () => void {
    const supabase = getSupabase();
    const channel = supabase
      .channel(`bot-stop-${this.email.replace(/[^a-zA-Z0-9]/g, '_')}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'bots',
          filter: `email=eq.${encodeURIComponent(this.email)}`,
        },
        (payload) => {
          const newStatus = (payload.new as Record<string, unknown>)?.status;
          if (newStatus === 'STOPPED') {
            onStopRequested();
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }

  /**
   * Fetches the latest filters from the database (queries Supabase each call).
   *
   * `working_hours` and `min_gap_minutes` are dedicated columns, not part of the
   * `filters` JSON. They are merged into the returned object under their column
   * names (not their camelCase filter names) so that `toBotFilters` can tell a
   * column value apart from its JSON equivalent and apply the documented
   * column-wins precedence. See the precedence comment on `toBotFilters`.
   */
  async getFilters(): Promise<Record<string, unknown>> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('bots')
      .select('filters, working_hours, min_gap_minutes')
      .eq('email', this.email)
      .single();

    if (error) {
      throw new Error(`BotStateService.getFilters: ${error.message}`);
    }
    const row = (data ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = {
      ...((row.filters as Record<string, unknown>) ?? {}),
    };

    const workingHours = row.working_hours;
    if (workingHours && typeof workingHours === 'object') {
      merged.working_hours = workingHours;
    }

    // Only forward a usable column value; a NULL/garbage column must fall through
    // to the filters JSON rather than silently disabling the gap filter.
    const minGapMinutes = row.min_gap_minutes;
    if (typeof minGapMinutes === 'number' && Number.isFinite(minGapMinutes) && minGapMinutes >= 0) {
      merged.min_gap_minutes = minGapMinutes;
    }

    return merged;
  }

  /** Fetches the current status from the database (for daemon: poll until RUNNING). */
  async getStatus(): Promise<BotStatus> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('bots')
      .select('status')
      .eq('email', this.email)
      .single();

    if (error) {
      throw new Error(`BotStateService.getStatus: ${error.message}`);
    }
    return (data?.status as BotStatus) ?? 'STOPPED';
  }
}
