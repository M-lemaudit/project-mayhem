/**
 * Automation loop: poll offers, filter, accept on match. SIMULATION MODE (acceptOffer is mocked).
 * Dynamic filters from Supabase; heartbeat every 5 cycles.
 */

import type { BlacklaneApi, BotStateService } from '../services';
import { RateLimitError, TokenExpiredError } from '../services';
import { getGlobalSettings } from '../config/global-settings';
import { FilterEngine, getOfferPrice, type BotFilters, type ExistingRide, type OfferShape } from './filter-engine';
import { getSupabase } from '../config/supabase';
import { logger } from '../utils';

const HEARTBEAT_INTERVAL_CYCLES = 5;
const RATE_LIMIT_BACKOFF_SECONDS = 300; // 5 minutes
const STOP_CHECK_INTERVAL_MS = 8_000; // pendant la pause rate-limit, vérifier le statut toutes les 8 s
const DEFAULT_WORKING_HOURS_START = 6;
const DEFAULT_WORKING_HOURS_END = 22;
const SLEEP_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes when outside working hours
const COFFEE_BREAK_MIN_REQUESTS = 50;
const COFFEE_BREAK_MAX_REQUESTS = 100;
const COFFEE_BREAK_MIN_MS = 2 * 60 * 1000; // 2 minutes
const COFFEE_BREAK_MAX_MS = 5 * 60 * 1000; // 5 minutes
const PROCESSED_OFFER_IDS_MAX = 500;
const MATCH_COOLDOWN_MIN_MS = 5 * 1000; // 5 seconds
const MATCH_COOLDOWN_MAX_MS = 10 * 1000; // 10 seconds

/** Normalize raw filters from DB to BotFilters shape. */
function toBotFilters(raw: Record<string, unknown>): BotFilters {
  const workingHours = raw.working_hours as { start?: number; end?: number } | undefined;
  const start =
    typeof workingHours?.start === 'number'
      ? workingHours.start
      : typeof raw.workingHoursStart === 'number'
        ? raw.workingHoursStart
        : DEFAULT_WORKING_HOURS_START;
  const end =
    typeof workingHours?.end === 'number'
      ? workingHours.end
      : typeof raw.workingHoursEnd === 'number'
        ? raw.workingHoursEnd
        : DEFAULT_WORKING_HOURS_END;
  return {
    minPrice: typeof raw.minPrice === 'number' ? raw.minPrice : 0,
    allowedVehicleTypes: Array.isArray(raw.allowedVehicleTypes)
      ? (raw.allowedVehicleTypes as string[])
      : [],
    ...(typeof raw.maxPrice === 'number' && { maxPrice: raw.maxPrice }),
    ...(typeof raw.maxDistance === 'number' && { maxDistance: raw.maxDistance }),
    ...(typeof raw.minHoursFromNow === 'number' && { minHoursFromNow: raw.minHoursFromNow }),
    ...(typeof raw.minGapMinutes === 'number' && raw.minGapMinutes >= 0 && { minGapMinutes: raw.minGapMinutes }),
    workingHoursStart: start,
    workingHoursEnd: end,
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

const OFFER_DATE_KEYS = ['pickup_at', 'starts_at', 'scheduled_at', 'start_time', 'pickup_time', 'datetime'];

/** Extract pickup/start date from offer for last_match display. Returns ISO string or undefined. */
function getOfferPickupIso(offer: OfferShape): string | undefined {
  const attrs = offer?.attributes as Record<string, unknown> | undefined;
  for (const key of OFFER_DATE_KEYS) {
    const v = attrs?.[key] ?? (offer as Record<string, unknown>)[key];
    if (v == null) continue;
    if (typeof v === 'number' && v > 0) return new Date(v).toISOString();
    if (typeof v === 'string' && v.trim()) {
      const d = new Date(v.trim());
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return undefined;
}

/** Log raw API response (first cycle only, for debug). */
function logRawOffersResponse(prefix: string, data: unknown, offers: OfferShape[]): void {
  if (offers.length > 0) {
    const first = offers[0] as Record<string, unknown>;
    console.log(`${prefix} (debug) 1ère offre clés:`, Object.keys(first).join(', '));
  }
}

/** Current local hour (0-23) on the server. */
function getCurrentLocalHour(): number {
  return new Date().getHours();
}

/** Current hour (0-23) in the given IANA timezone (e.g. Europe/Paris). Falls back to server local if invalid. */
function getCurrentHourInTimezone(timezoneId: string): number {
  const tz = timezoneId?.trim();
  if (!tz) return getCurrentLocalHour();
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false,
    });
    const hourStr = formatter.format(new Date());
    const hour = parseInt(hourStr, 10);
    if (Number.isNaN(hour) || hour < 0 || hour > 23) return getCurrentLocalHour();
    return hour;
  } catch {
    return getCurrentLocalHour();
  }
}

/** Format current date/time in the given IANA timezone for display (e.g. "26/02/2025 14:32:05 Europe/Paris"). */
function formatNowInTimezone(timezoneId: string): string {
  try {
    const formatter = new Intl.DateTimeFormat('fr-FR', {
      timeZone: timezoneId,
      dateStyle: 'short',
      timeStyle: 'medium',
    });
    return `${formatter.format(new Date())} (${timezoneId})`;
  } catch {
    return new Date().toLocaleString('fr-FR') + ' (server local, TZ invalid)';
  }
}

/** Format an ISO date string as day + time for display (e.g. "vendredi 28/02/2025 15:00"). Uses client timezone if provided. */
function formatRideDateTime(iso: string | undefined, timezoneId?: string): string {
  if (!iso || !iso.trim()) return '—';
  const d = new Date(iso.trim());
  if (Number.isNaN(d.getTime())) return iso;
  try {
    const formatter = new Intl.DateTimeFormat('fr-FR', {
      timeZone: timezoneId || Intl.DateTimeFormat().resolvedOptions().timeZone,
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return formatter.format(d);
  } catch {
    return d.toLocaleString('fr-FR');
  }
}

/** True if current time is inside [workingHoursStart, workingHoursEnd) (end exclusive). Uses client timezone when provided. */
function isInsideWorkingHours(
  start: number,
  end: number,
  timezoneId?: string
): boolean {
  const hour = timezoneId ? getCurrentHourInTimezone(timezoneId) : getCurrentLocalHour();
  if (start <= end) return hour >= start && hour < end;
  // e.g. 22–6: inside if hour >= 22 || hour < 6
  return hour >= start || hour < end;
}

/**
 * Sniper loop: poll getOffers(), filter with FilterEngine, call acceptOffer on match (simulated).
 * botState is passed for future Realtime STOP command listening.
 */
export class SniperLoop {
  isRunning = false;
  filters: BotFilters;
  private readonly logPrefix: string;
  /** IDs of offers already matched (simulation) to avoid re-matching and repeated notifs/restarts. */
  private processedOfferIds = new Set<string>();
  /** Bot UUID for querying rides (time-gap check). */
  private readonly botId: string | undefined;
  /** IANA timezone for "now" in gate time / working hours (e.g. Europe/Paris). */
  private readonly timezoneId: string | undefined;

  constructor(
    private readonly api: BlacklaneApi,
    filters: BotFilters,
    private readonly botState?: BotStateService,
    botEmail?: string,
    botId?: string,
    timezoneId?: string
  ) {
    this.filters = filters;
    this.logPrefix = botEmail ? `[${botEmail}]` : '[BOT]';
    this.botId = botId;
    this.timezoneId = timezoneId?.trim() || undefined;
  }

  stop(): void {
    this.isRunning = false;
  }

  async start(): Promise<void> {
    this.isRunning = true;

    if (this.botState) {
      await this.botState.updateStatus('RUNNING');
    }

    if (this.timezoneId) {
      console.log(`${this.logPrefix} Heure client: ${formatNowInTimezone(this.timezoneId)}`);
    } else {
      console.log(`${this.logPrefix} Heure client: ${new Date().toLocaleString('fr-FR')} (server local, pas de timezone)`);
    }

    let unsubscribeRealtime: (() => void) | undefined;
    if (this.botState) {
      unsubscribeRealtime = this.botState.subscribeToRemoteStop(() => {
        console.log(`${this.logPrefix} Stop reçu (dashboard) → arrêt.`);
        this.isRunning = false;
      });
    }
    let cycleCount = 0;
    let lastFiltersJson = JSON.stringify(this.filters);
    let rawResponseLoggedOnce = false;
    let requestCount = 0;
    let nextCoffeeBreakAt =
      Math.floor(Math.random() * (COFFEE_BREAK_MAX_REQUESTS - COFFEE_BREAK_MIN_REQUESTS + 1)) +
      COFFEE_BREAK_MIN_REQUESTS;

    try {
      while (this.isRunning) {
        try {
          cycleCount += 1;

          if (this.botState) {
            const status = await this.botState.getStatus();
            if (status === 'STOPPED') {
              console.log(`${this.logPrefix} Stop (dashboard) → arrêt.`);
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

          const startHour = filters.workingHoursStart ?? DEFAULT_WORKING_HOURS_START;
          const endHour = filters.workingHoursEnd ?? DEFAULT_WORKING_HOURS_END;
          if (!isInsideWorkingHours(startHour, endHour, this.timezoneId)) {
            const tzLabel = this.timezoneId ? ` (${this.timezoneId})` : '';
            console.log(
              `${this.logPrefix} 💤 Sleeping until ${startHour}:00${tzLabel}...`
            );
            if (this.botState) {
              await this.botState.updateStatus('SLEEPING').catch(() => {});
            }
            await sleep(SLEEP_CHECK_INTERVAL_MS);
            continue;
          }

          if (this.botState) {
            const status = await this.botState.getStatus();
            if (status === 'SLEEPING') {
              await this.botState.updateStatus('RUNNING').catch(() => {});
            }
          }

          if (requestCount >= nextCoffeeBreakAt) {
            const breakMs =
              Math.floor(Math.random() * (COFFEE_BREAK_MAX_MS - COFFEE_BREAK_MIN_MS + 1)) +
              COFFEE_BREAK_MIN_MS;
            console.log(`${this.logPrefix} ☕ Taking a short break (${Math.round(breakMs / 60_000)} min).`);
            await sleep(breakMs);
            nextCoffeeBreakAt =
              requestCount +
              Math.floor(Math.random() * (COFFEE_BREAK_MAX_REQUESTS - COFFEE_BREAK_MIN_REQUESTS + 1)) +
              COFFEE_BREAK_MIN_REQUESTS;
          }

          const data = await this.api.getOffers();
          requestCount += 1;
          const offers = getOffersList(data);
          if (!rawResponseLoggedOnce) {
            logRawOffersResponse(this.logPrefix, data, offers);
            rawResponseLoggedOnce = true;
          }
          let existingRides: ExistingRide[] = [];
          if (this.botId && typeof filters.minGapMinutes === 'number' && filters.minGapMinutes > 0) {
            try {
              const supabase = getSupabase();
              const { data } = await supabase
                .from('rides')
                .select('start_at, end_at')
                .eq('bot_id', this.botId)
                .gt('start_at', new Date().toISOString());
              existingRides = (data ?? []) as ExistingRide[];
            } catch {
              existingRides = [];
            }
          }

          let hadMatchThisCycle = false;
          if (offers.length > 0) {
            for (const offer of offers) {
              if (!this.isRunning) break;
              const id = (offer as OfferShape & { id?: string }).id ?? 'unknown';
              const idStr = String(id);
              if (this.processedOfferIds.has(idStr)) continue;

              const result = FilterEngine.isMatch(offer, filters, existingRides);

              if (result.match) {
                this.processedOfferIds.add(idStr);
                if (this.processedOfferIds.size > PROCESSED_OFFER_IDS_MAX) {
                  this.processedOfferIds.clear();
                }
                const attrs = (offer as OfferShape).attributes as Record<string, unknown> | undefined;
                const price =
                  attrs?.price ??
                  (offer as OfferShape).price ??
                  (offer as OfferShape).price_amount ??
                  '?';
                const pickupAt = getOfferPickupIso(offer);
                if (this.botState) {
                  await this.botState
                    .reportMatch(idStr, price as string | number, pickupAt)
                    .catch(() => {});
                }
                await this.api.acceptOffer(offer);
                const rideDateTime = formatRideDateTime(pickupAt, this.timezoneId);
                console.log(`${this.logPrefix} 🎯 Offer ${idStr} handled. Course: ${rideDateTime}. Entering cooldown before next scan...`);
                hadMatchThisCycle = true;
                break;
              }
            }
          }

          if (hadMatchThisCycle) {
            const cooldownMs =
              Math.floor(Math.random() * (MATCH_COOLDOWN_MAX_MS - MATCH_COOLDOWN_MIN_MS + 1)) +
              MATCH_COOLDOWN_MIN_MS;
            await sleep(cooldownMs);
          }

          console.log(`${this.logPrefix} Cycle ${cycleCount}: ${offers.length} offre(s).`);

          if (this.botState && cycleCount % HEARTBEAT_INTERVAL_CYCLES === 0) {
            await this.botState.updateHeartbeat();
          }

          if (!this.isRunning) break;
          const { sniper_delay_min_ms, sniper_delay_max_ms } = await getGlobalSettings();
          await randomSleep(sniper_delay_min_ms, sniper_delay_max_ms);
        } catch (err) {
          if (err instanceof TokenExpiredError) {
            console.log(`${this.logPrefix} Session expirée.`);
            if (this.botState) {
              await this.botState.saveSession({}).catch(() => {});
              await this.botState.updateStatus('ERROR_AUTH').catch(() => {});
            }
            throw err;
          } else if (err instanceof RateLimitError) {
            const backoffSeconds =
              typeof err.retryAfter === 'number' && err.retryAfter > 0
                ? err.retryAfter
                : RATE_LIMIT_BACKOFF_SECONDS;
            const rateLimitEnd = Date.now() + backoffSeconds * 1000;
            const resumeAt = new Date(rateLimitEnd);
            console.log(
              `${this.logPrefix} Rate limit → pause ${backoffSeconds}s (reprise à ${resumeAt.toLocaleTimeString()}, Stop vérifié toutes les 8 s).`
            );
            if (this.botState) await this.botState.updateStatus('PAUSED_RATE_LIMIT').catch(() => {});

            while (Date.now() < rateLimitEnd && this.isRunning) {
              const remainingMs = rateLimitEnd - Date.now();
              const sleepMs = Math.min(STOP_CHECK_INTERVAL_MS, Math.max(0, remainingMs));
              if (sleepMs > 0) await sleep(sleepMs);

              if (this.botState) {
                const status = await this.botState.getStatus();
                if (status === 'STOPPED') {
                  console.log(`${this.logPrefix} Stop (dashboard) → arrêt.`);
                  this.isRunning = false;
                  break;
                }
              }
            }

            if (!this.isRunning) break;
            console.log(`${this.logPrefix} Pause rate limit terminée → reprise.`);
            const status = this.botState ? await this.botState.getStatus() : 'RUNNING';
            if (status !== 'STOPPED' && this.botState) {
              await this.botState.updateStatus('RUNNING').catch(() => {});
            }
          } else {
            console.error(`${this.logPrefix} Erreur cycle:`, err);
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
