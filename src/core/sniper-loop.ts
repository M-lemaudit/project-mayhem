/**
 * Automation loop: poll offers, filter, accept on match. SIMULATION MODE (acceptOffer is mocked).
 * Dynamic filters from Supabase; heartbeat every 5 cycles.
 */

import type { BlacklaneApi, BotStateService } from '../services';
import { RateLimitError, TokenExpiredError } from '../services';
import { FilterEngine, type BotFilters, type OfferShape } from './filter-engine';
import { logger } from '../utils';

const HEARTBEAT_INTERVAL_CYCLES = 5;
const RATE_LIMIT_BACKOFF_SECONDS = 300; // 5 minutes
const STOP_CHECK_INTERVAL_MS = 8_000; // pendant la pause rate-limit, vérifier le statut toutes les 8 s

/** Normalize raw filters from DB to BotFilters shape. */
function toBotFilters(raw: Record<string, unknown>): BotFilters {
  return {
    minPrice: typeof raw.minPrice === 'number' ? raw.minPrice : 0,
    allowedVehicleTypes: Array.isArray(raw.allowedVehicleTypes)
      ? (raw.allowedVehicleTypes as string[])
      : [],
    ...(typeof raw.maxPrice === 'number' && { maxPrice: raw.maxPrice }),
    ...(typeof raw.maxDistance === 'number' && { maxDistance: raw.maxDistance }),
    ...(typeof raw.minHoursFromNow === 'number' && { minHoursFromNow: raw.minHoursFromNow }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function randomSleep(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(ms);
}

function getOffersList(data: unknown): OfferShape[] {
  if (Array.isArray(data)) return data as OfferShape[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.offers)) return obj.offers as OfferShape[];
    if (Array.isArray(obj.data)) return obj.data as OfferShape[];
  }
  return [];
}

/** Log raw API response (first cycle only, for debug). */
function logRawOffersResponse(data: unknown, offers: OfferShape[]): void {
  if (offers.length > 0) {
    const first = offers[0] as Record<string, unknown>;
    console.log('[BOT] (debug) 1ère offre clés:', Object.keys(first).join(', '));
  }
}

/**
 * Sniper loop: poll getOffers(), filter with FilterEngine, call acceptOffer on match (simulated).
 * botState is passed for future Realtime STOP command listening.
 */
export class SniperLoop {
  isRunning = false;
  filters: BotFilters;

  constructor(
    private readonly api: BlacklaneApi,
    filters: BotFilters,
    private readonly botState?: BotStateService
  ) {
    this.filters = filters;
  }

  async start(): Promise<void> {
    this.isRunning = true;

    if (this.botState) {
      await this.botState.updateStatus('RUNNING');
    }

    let unsubscribeRealtime: (() => void) | undefined;
    if (this.botState) {
      unsubscribeRealtime = this.botState.subscribeToRemoteStop(() => {
        console.log('[BOT] Stop reçu (dashboard) l’admin → arrêt.');
        this.isRunning = false;
      });
    }
    let cycleCount = 0;
    let lastFiltersJson = JSON.stringify(this.filters);
    let rawResponseLoggedOnce = false;

    try {
      while (this.isRunning) {
        try {
          cycleCount += 1;

          if (this.botState) {
            const status = await this.botState.getStatus();
            if (status === 'STOPPED') {
              console.log('[BOT] Stop (dashboard) → arrêt.');
              this.isRunning = false;
              break;
            }
          }

          let filters: BotFilters = this.filters;
          if (this.botState) {
            const raw = await this.botState.getFilters();
            filters = toBotFilters(raw);
            const filtersJson = JSON.stringify(filters);
            if (filtersJson !== lastFiltersJson) {
              lastFiltersJson = filtersJson;
              
            }
          }

          const data = await this.api.getOffers();
          const offers = getOffersList(data);
          if (!rawResponseLoggedOnce) {
            logRawOffersResponse(data, offers);
            rawResponseLoggedOnce = true;
          }
          if (offers.length > 0) {
            for (const offer of offers) {
              if (!this.isRunning) break;
              const result = FilterEngine.isMatch(offer, filters);

              if (result.match) {
                const id = (offer as OfferShape & { id?: string }).id ?? 'unknown';
                const attrs = (offer as OfferShape).attributes as Record<string, unknown> | undefined;
                const price = attrs?.price ?? (offer as OfferShape).price ?? (offer as OfferShape).price_amount ?? '?';
                console.log(`[BOT] Match (id=${id}, prix=${price}) → popup admin.`);
                if (this.botState) {
                  await this.botState.reportMatch(String(id), price as string | number).catch(() => {});
                }
                await this.api.acceptOffer(String(id));
                return;
              }
            }
          }

          console.log(`[BOT] Cycle ${cycleCount}: ${offers.length} offre(s).`);

          if (this.botState && cycleCount % HEARTBEAT_INTERVAL_CYCLES === 0) {
            await this.botState.updateHeartbeat();
          }

          if (!this.isRunning) break;
          await sleep(Math.floor(Math.random() * 1001) + 1000);
        } catch (err) {
          if (err instanceof TokenExpiredError) {
            console.log('[BOT] Session expirée.');
            if (this.botState) {
              await this.botState.saveSession({}).catch(() => {});
              await this.botState.updateStatus('ERROR_AUTH').catch(() => {});
            }
            throw err;
          } else if (err instanceof RateLimitError) {
            console.log('[BOT] Rate limit → pause 5 min (Stop vérifié toutes les 8 s).');
            if (this.botState) await this.botState.updateStatus('PAUSED_RATE_LIMIT').catch(() => {});
            const rateLimitEnd = Date.now() + RATE_LIMIT_BACKOFF_SECONDS * 1000;
            while (Date.now() < rateLimitEnd && this.isRunning) {
              await sleep(STOP_CHECK_INTERVAL_MS);
              if (this.botState) {
                const status = await this.botState.getStatus();
                if (status === 'STOPPED') {
                  console.log('[BOT] Stop (dashboard) → arrêt.');
                  this.isRunning = false;
                  break;
                }
              }
            }
            if (!this.isRunning) break;
            const status = this.botState ? await this.botState.getStatus() : 'RUNNING';
            if (status !== 'STOPPED' && this.botState) {
              await this.botState.updateStatus('RUNNING').catch(() => {});
            }
          } else {
            console.error('[BOT] Erreur cycle:', err);
            if (this.botState) await this.botState.updateStatus('ERROR_AUTH').catch(() => {});
          }
        }
      }
    } catch (err) {
      if (this.botState) {
        await this.botState.updateStatus('ERROR_AUTH').catch(() => {});
      }
      throw err;
    } finally {
      unsubscribeRealtime?.();
    }
  }
}

export default SniperLoop;
