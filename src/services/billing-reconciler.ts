/**
 * Billing reconciliation: cross-references what the bot booked (`accepted_offers`) against
 * what was actually completed on Blacklane (GET /hades/finished_rides, status finished|no_show).
 *
 * The two sides share no id — `accepted_offers.offer_id` is a partner-portal offer uuid while
 * a finished ride exposes its own ride uuid / booking_number — so matching is done on the
 * pickup instant (`pickup_at` ↔ `starts_at`) plus price, with accepted-at as a tiebreaker.
 * Only matched offers become billable; finished rides the driver got manually never match and
 * are ignored. Writes are idempotent via the unique index on accepted_offers.finished_ride_uuid.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { BlacklaneApi, FinishedRide } from './blacklane-api';
import { logger } from '../utils';

/** Pickup times are the same scheduled instant on both sides; this only absorbs rounding. */
const MATCH_WINDOW_MS = 2 * 60_000;
/** Page finished_rides back to (oldest unreconciled pickup − this) to be safe against ordering. */
const WINDOW_BUFFER_MS = 24 * 60 * 60_000;

interface UnreconciledOffer {
  id: string;
  price: number | null;
  pickupAtMs: number;
  createdAtMs: number;
}

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
      .select('id, price, pickup_at, created_at')
      .eq('bot_id', this.botId)
      .is('reconciled_at', null)
      .not('pickup_at', 'is', null)
      .lt('pickup_at', nowIso);

    if (offerErr) {
      logger.warn(`${prefix} Load accepted_offers failed: ${offerErr.message}`);
      return { matched: 0 };
    }

    const offers: UnreconciledOffer[] = (offerRows ?? [])
      .map((r) => {
        const pickupAtMs = r.pickup_at ? new Date(r.pickup_at as string).getTime() : NaN;
        const priceNum = r.price != null ? Number(r.price) : NaN;
        return {
          id: r.id as string,
          price: Number.isFinite(priceNum) ? priceNum : null,
          pickupAtMs,
          createdAtMs: r.created_at ? new Date(r.created_at as string).getTime() : 0,
        };
      })
      .filter((o) => Number.isFinite(o.pickupAtMs));

    if (offers.length === 0) {
      logger.info(`${prefix} No unreconciled past offers; skipping.`);
      return { matched: 0 };
    }

    // Skip finished rides already attributed to this bot so re-runs never collide on the uuid index.
    const { data: usedRows } = await this.supabase
      .from('accepted_offers')
      .select('finished_ride_uuid')
      .eq('bot_id', this.botId)
      .not('finished_ride_uuid', 'is', null);
    const usedUuids = new Set<string>(
      (usedRows ?? []).map((r) => r.finished_ride_uuid as string).filter(Boolean)
    );

    const oldestPickupMs = Math.min(...offers.map((o) => o.pickupAtMs));
    const cutoffMs = oldestPickupMs - WINDOW_BUFFER_MS;

    let finished: FinishedRide[];
    try {
      finished = await api.getFinishedRides(cutoffMs);
    } catch (err) {
      logger.warn(`${prefix} getFinishedRides failed: ${err instanceof Error ? err.message : String(err)}`);
      return { matched: 0 };
    }

    let matched = 0;
    const claimed = new Set<string>(); // offer ids matched this run
    for (const ride of finished) {
      if (usedUuids.has(ride.rideUuid)) continue;
      const candidate = this.bestCandidate(ride, offers, claimed);
      if (!candidate) continue;

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
        .eq('id', candidate.id)
        .is('reconciled_at', null); // guard against a concurrent run claiming it first

      if (updErr) {
        logger.warn(`${prefix} Update offer ${candidate.id} failed: ${updErr.message}`);
        continue;
      }
      claimed.add(candidate.id);
      usedUuids.add(ride.rideUuid);
      matched += 1;
    }

    logger.info(
      `${prefix} 💵 Reconciled ${matched}/${offers.length} unmatched offers against ${finished.length} finished rides.`
    );
    return { matched };
  }

  /** Closest unclaimed offer within the time window; ties broken by price then accepted-at proximity. */
  private bestCandidate(
    ride: FinishedRide,
    offers: UnreconciledOffer[],
    claimed: Set<string>
  ): UnreconciledOffer | null {
    const rideMs = ride.startsAt.getTime();
    const acceptedMs = ride.acceptedAt?.getTime() ?? null;
    let best: UnreconciledOffer | null = null;
    let bestScore = Infinity;
    for (const offer of offers) {
      if (claimed.has(offer.id)) continue;
      const timeDelta = Math.abs(offer.pickupAtMs - rideMs);
      if (timeDelta > MATCH_WINDOW_MS) continue;
      const priceDelta = offer.price != null ? Math.abs(offer.price - ride.price) : 0;
      const acceptDelta =
        acceptedMs != null ? Math.abs(offer.createdAtMs - acceptedMs) / 60_000 : 0;
      // Time is the primary signal; price and accepted-at only separate near-simultaneous rides.
      const score = timeDelta + priceDelta * 1000 + acceptDelta;
      if (score < bestScore) {
        bestScore = score;
        best = offer;
      }
    }
    return best;
  }
}
