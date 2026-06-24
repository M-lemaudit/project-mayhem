/**
 * Billing reconciliation: cross-references what the bot booked (`accepted_offers`) against
 * what was actually completed on Blacklane (GET /hades/finished_rides, status finished|no_show).
 *
 * The offer the bot accepted and the finished ride are the SAME entity: `accepted_offers.offer_id`
 * is byte-for-byte the finished ride's `id`. So reconciliation is a direct id lookup — no fuzzy
 * time/price matching (which previously mis-billed unrelated rides that merely shared a pickup
 * minute). For each past, not-yet-reconciled offer whose offer_id appears among the finished rides,
 * we stamp the real completed price/status; the 3% fee is computed at read time on the dashboard.
 * Writes are idempotent (the unique index on finished_ride_uuid + the reconciled_at guard).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { BlacklaneApi, FinishedRide } from './blacklane-api';
import { logger } from '../utils';

/** Page finished_rides back to (oldest unreconciled pickup − this) so no completed ride is missed. */
const WINDOW_BUFFER_MS = 24 * 60 * 60_000;

export class BillingReconciler {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly botId: string
  ) {}

  /**
   * Fetches this bot's completed rides and stamps the matching accepted_offers as billable.
   * Returns the number of newly matched offers. Safe to run repeatedly (no double-billing).
   */
  async reconcile(api: BlacklaneApi): Promise<{ matched: number }> {
    const prefix = `[BillingReconciler bot=${this.botId}]`;

    // Only past, not-yet-reconciled offers can have a completed ride waiting to be matched.
    const nowIso = new Date().toISOString();
    const { data: offerRows, error: offerErr } = await this.supabase
      .from('accepted_offers')
      .select('id, offer_id, pickup_at')
      .eq('bot_id', this.botId)
      .is('reconciled_at', null)
      .not('pickup_at', 'is', null)
      .lt('pickup_at', nowIso);

    if (offerErr) {
      logger.warn(`${prefix} Load accepted_offers failed: ${offerErr.message}`);
      return { matched: 0 };
    }

    const offers = (offerRows ?? [])
      .map((r) => ({
        id: r.id as string,
        offerId: typeof r.offer_id === 'string' ? r.offer_id : '',
        pickupAtMs: r.pickup_at ? new Date(r.pickup_at as string).getTime() : NaN,
      }))
      .filter((o) => o.offerId && Number.isFinite(o.pickupAtMs));

    if (offers.length === 0) {
      logger.info(`${prefix} No unreconciled past offers; skipping.`);
      return { matched: 0 };
    }

    // Page finished rides back far enough to cover the oldest unmatched offer.
    const oldestPickupMs = Math.min(...offers.map((o) => o.pickupAtMs));
    const cutoffMs = oldestPickupMs - WINDOW_BUFFER_MS;

    let finished: FinishedRide[];
    try {
      finished = await api.getFinishedRides(cutoffMs);
    } catch (err) {
      logger.warn(`${prefix} getFinishedRides failed: ${err instanceof Error ? err.message : String(err)}`);
      return { matched: 0 };
    }

    // The offer id IS the finished ride id — match by direct lookup.
    const finishedById = new Map<string, FinishedRide>();
    for (const ride of finished) finishedById.set(ride.rideUuid, ride);

    let matched = 0;
    for (const offer of offers) {
      const ride = finishedById.get(offer.offerId);
      if (!ride) continue;

      const { error: updErr } = await this.supabase
        .from('accepted_offers')
        .update({
          completed_status: ride.status,
          finished_ride_uuid: ride.rideUuid,
          booking_number: ride.bookingNumber || null,
          finished_price: ride.price,
          finished_currency: ride.currency || null,
          completed_at: ride.startsAt.toISOString(),
          reconciled_at: new Date().toISOString(),
        })
        .eq('id', offer.id)
        .is('reconciled_at', null); // guard against a concurrent run claiming it first

      if (updErr) {
        logger.warn(`${prefix} Update offer ${offer.id} failed: ${updErr.message}`);
        continue;
      }
      matched += 1;
    }

    logger.info(
      `${prefix} 💵 Reconciled ${matched}/${offers.length} unmatched offers against ${finished.length} finished rides.`
    );
    return { matched };
  }
}
