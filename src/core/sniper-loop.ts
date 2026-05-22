/**
 * Automation loop: poll offers, filter, accept on match. SIMULATION MODE (acceptOffer is mocked).
 * Dynamic filters from Supabase; heartbeat every 5 cycles.
 */

import type { BlacklaneApi, BotStateService } from '../services';
import { InvalidOfferStateError, RateLimitError, TokenExpiredError } from '../services';
import { getGlobalSettings } from '../config/global-settings';
import { FilterEngine, getOfferPrice, resolveOfferLocations, type BotFilters, type ExistingRide, type IncludedResource, type OfferShape } from './filter-engine';
import { getSupabase } from '../config/supabase';
import {
  extractHttpStatusCode,
  isLikelyDatabaseDown,
  logger,
  toErrorDetails,
  triggerOfferAcceptErrorWebhook,
} from '../utils';

const HEARTBEAT_INTERVAL_CYCLES = 5;
const RATE_LIMIT_BACKOFF_SECONDS = 300; // 5 minutes
const STOP_CHECK_INTERVAL_MS = 8_000; // pendant la pause rate-limit, vérifier le statut toutes les 8 s
const DEFAULT_WORKING_HOURS_START = 6;
const DEFAULT_WORKING_HOURS_END = 22;
const COFFEE_BREAK_MIN_REQUESTS = 50;
const COFFEE_BREAK_MAX_REQUESTS = 100;
const COFFEE_BREAK_MIN_MS = 2 * 60 * 1000; // 2 minutes
const COFFEE_BREAK_MAX_MS = 5 * 60 * 1000; // 5 minutes
const PROCESSED_OFFER_IDS_MAX = 500;
const MATCH_COOLDOWN_MIN_MS = 5 * 1000; // 5 seconds
const MATCH_COOLDOWN_MAX_MS = 10 * 1000; // 10 seconds
const MAX_UNKNOWN_ERRORS_BEFORE_ERROR_AUTH = 2;
const STANDBY_POLL_MS = 30_000;

function getTodayIsoDateInTimezone(timezoneId?: string): string {
  const tz = timezoneId?.trim();
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(new Date());
  } catch {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

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

  // Normalize rideType from Supabase (supports both rideType and ride_type).
  let normalizedRideType: string | undefined;
  const rawRideType =
    (typeof raw.rideType === 'string' && raw.rideType.trim()
      ? raw.rideType
      : typeof (raw as Record<string, unknown>).ride_type === 'string'
        ? (raw as Record<string, unknown>).ride_type
        : undefined) as string | undefined;
  if (rawRideType) {
    const v = rawRideType.trim().toLowerCase();
    if (v === 'transfer' || v === 'hourly' || v === 'both') {
      normalizedRideType = v;
    }
  }

  return {
    minPrice: typeof raw.minPrice === 'number' ? raw.minPrice : 0,
    allowedVehicleTypes: Array.isArray(raw.allowedVehicleTypes)
      ? (raw.allowedVehicleTypes as string[])
      : [],
    ...(typeof raw.maxPrice === 'number' && { maxPrice: raw.maxPrice }),
    ...(typeof raw.maxDistance === 'number' && { maxDistance: raw.maxDistance }),
    ...(typeof raw.minHoursFromNow === 'number' && { minHoursFromNow: raw.minHoursFromNow }),
    ...(typeof raw.minLeadHours === 'number' && { minHoursFromNow: raw.minLeadHours }),
    ...(typeof raw.minGapMinutes === 'number' && raw.minGapMinutes >= 0 && { minGapMinutes: raw.minGapMinutes }),
    workingHoursStart: start,
    workingHoursEnd: end,
    // New Supabase-driven filters
    ...(normalizedRideType && { rideType: normalizedRideType }),
    // Airport direction: ['pickup'], ['dropoff'], or both; default handled in filter-engine when undefined.
    ...(Array.isArray((raw as any).allowedAirportDirections) &&
      (raw as any).allowedAirportDirections.length > 0 && {
        allowedAirportDirections: (raw as any).allowedAirportDirections as string[],
      }),
    // Allowed airlines: prefer new field, fallback to legacy includedAirlines.
    // NOTE: Despite the historical name `allowedAirlines`, this list is now interpreted
    // as a BLOCKLIST in FilterEngine: if a flight_number matches one of these codes,
    // the offer is rejected. An empty list means "do not block any airline".
    ...(Array.isArray((raw as any).allowedAirlines) &&
      (raw as any).allowedAirlines.length > 0 && {
        allowedAirlines: ((raw as any).allowedAirlines as string[]).map((c) =>
          typeof c === 'string' ? c.trim().toUpperCase() : ''
        ),
      }),
    ...(!Array.isArray((raw as any).allowedAirlines) ||
    (raw as any).allowedAirlines.length === 0
      ? Array.isArray((raw as any).includedAirlines) &&
        (raw as any).includedAirlines.length > 0 && {
          allowedAirlines: ((raw as any).includedAirlines as string[]).map((c) =>
            typeof c === 'string' ? c.trim().toUpperCase() : ''
          ),
        }
      : {}),
    // City filters: split into pickup/dropoff; fallback to legacy allowedZipCodes/blockedZipCodes.
    // NOTE: `allowedPickupCities` / `allowedDropoffCities` are also interpreted as BLOCKLISTS
    // in FilterEngine: if the resolved pickup/dropoff city is in the list, the offer is rejected.
    // Empty lists mean "no city is blocked" (all pickup/dropoff cities are allowed).
    ...(Array.isArray((raw as any).allowedPickupCities) &&
      (raw as any).allowedPickupCities.length > 0 && {
        allowedPickupCities: (raw as any).allowedPickupCities as string[],
      }),
    ...(Array.isArray((raw as any).allowedDropoffCities) &&
      (raw as any).allowedDropoffCities.length > 0 && {
        allowedDropoffCities: (raw as any).allowedDropoffCities as string[],
      }),
    ...((!Array.isArray((raw as any).allowedPickupCities) ||
      (raw as any).allowedPickupCities.length === 0) &&
    (!Array.isArray((raw as any).allowedDropoffCities) ||
      (raw as any).allowedDropoffCities.length === 0)
      ? Array.isArray((raw as any).allowedZipCodes) &&
        (raw as any).allowedZipCodes.length > 0 && {
          allowedPickupCities: (raw as any).allowedZipCodes as string[],
          allowedDropoffCities: (raw as any).allowedZipCodes as string[],
        }
      : {}),
    // Time-window filters (static)
    ...(Array.isArray((raw as any).blackoutDates) &&
      (raw as any).blackoutDates.length > 0 && {
        blackoutDates: ((raw as any).blackoutDates as unknown[]).flatMap((v) => {
          if (typeof v !== 'string') return [];
          const trimmed = v.trim();
          return trimmed ? [trimmed] : [];
        }),
      }),
    ...(() => {
      const allowedStart =
        typeof (raw as any).allowedStartDate === 'string' && (raw as any).allowedStartDate.trim()
          ? (raw as any).allowedStartDate
          : typeof (raw as any).dateStart === 'string' && (raw as any).dateStart.trim()
            ? (raw as any).dateStart
            : typeof (raw as any).date_start === 'string' && (raw as any).date_start.trim()
              ? (raw as any).date_start
              : undefined;
      const allowedEnd =
        typeof (raw as any).allowedEndDate === 'string' && (raw as any).allowedEndDate.trim()
          ? (raw as any).allowedEndDate
          : typeof (raw as any).dateEnd === 'string' && (raw as any).dateEnd.trim()
            ? (raw as any).dateEnd
            : typeof (raw as any).date_end === 'string' && (raw as any).date_end.trim()
              ? (raw as any).date_end
              : undefined;
      const out: Partial<BotFilters> = {};
      if (allowedStart) {
        out.allowedStartDate = String(allowedStart);
      }
      if (allowedEnd) {
        out.allowedEndDate = String(allowedEnd);
      }
      return out;
    })(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function randomSleep(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(ms);
}

function exponentialBackoffWithJitterMs(attempt: number): number {
  // attempt starts at 1
  const baseMs = 1_000;
  const capMs = 180_000; // 3 minutes
  const expMs = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitterFactor = 0.8 + Math.random() * 0.4; // +/- 20%
  return Math.floor(expMs * jitterFactor);
}

function isSoftNetworkError(err: unknown, statusCode?: number): boolean {
  if (statusCode === 401 || statusCode === 403) return false;

  const maybeErr = err as { code?: unknown; name?: unknown; message?: unknown } | undefined;
  const code = typeof maybeErr?.code === 'string' ? maybeErr.code.toUpperCase() : '';
  const name = typeof maybeErr?.name === 'string' ? maybeErr.name.toLowerCase() : '';
  const message = typeof maybeErr?.message === 'string' ? maybeErr.message.toLowerCase() : String(err).toLowerCase();

  if (name === 'timeouterror') return true;
  // 502/503 are handled in a dedicated "gateway" branch to keep the 3-rotations -> re-auth policy.
  if (statusCode === 502 || statusCode === 503) return false;
  if (statusCode === 504) return true;

  const networkCodes = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
  ]);
  if (networkCodes.has(code)) return true;

  return (
    message.includes('err_tunnel_connection_failed') ||
    message.includes('err_proxy_connection_failed') ||
    message.includes('socket hang up') ||
    message.includes('bad gateway') ||
    message.includes('network') ||
    message.includes('timeout')
  );
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

/** Extract the `included` array from a JSON:API response (locations, etc.). */
function getIncludedList(data: unknown): IncludedResource[] {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.included)) return obj.included as IncludedResource[];
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
    console.log(`${prefix} (debug) first offer keys:`, Object.keys(first).join(', '));
  }
}

/** Current local hour (0-23) on the server. */
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

/**
 * Sniper loop: poll getOffers(), filter with FilterEngine, call acceptOffer on match (simulated).
 * botState is passed for future Realtime STOP command listening.
 */
export class SniperLoop {
  isRunning = false;
  filters: BotFilters;
  private readonly logPrefix: string;
  private readonly botEmail: string;
  /** IDs of offers already matched (simulation) to avoid re-matching and repeated notifs/restarts. */
  private processedOfferIds = new Set<string>();
  /** Bot UUID for querying rides (time-gap check). */
  private readonly botId: string | undefined;
  /** IANA timezone for "now" in gate time / working hours (e.g. Europe/Paris). */
  private readonly timezoneId: string | undefined;
  /** Consecutive gateway errors (5xx like 502/503) seen in the hot loop. */
  private consecutiveGatewayErrors = 0;
  /** Consecutive proxy/network errors (timeouts, tunnel failures, etc.). Used for exponential backoff. */
  private consecutiveNetworkProxyErrors = 0;
  /** Consecutive non-gateway runtime errors without dedicated retry policy. */
  private consecutiveUnknownErrors = 0;
  /** Last local (bot timezone) date when blackoutDates pruning ran. */
  private lastBlackoutPruneIsoDate: string | null = null;
  private isStandby = false;

  constructor(
    private readonly api: BlacklaneApi,
    filters: BotFilters,
    private readonly botState?: BotStateService,
    botEmail?: string,
    botId?: string,
    timezoneId?: string
  ) {
    this.filters = filters;
    this.botEmail = botEmail ?? 'unknown';
    this.logPrefix = botEmail ? `[${botEmail}]` : '[BOT]';
    this.botId = botId;
    this.timezoneId = timezoneId?.trim() || undefined;
  }

  stop(): void {
    this.isRunning = false;
  }

  setStandby(on: boolean): void {
    this.isStandby = on;
  }

  async start(): Promise<void> {
    this.isRunning = true;

    if (this.botState) {
      await this.botState.updateStatus('RUNNING');
    }

    if (this.timezoneId) {
      console.log(`${this.logPrefix} Client time: ${formatNowInTimezone(this.timezoneId)}`);
    } else {
      console.log(
        `${this.logPrefix} Client time: ${new Date().toLocaleString('fr-FR')} (server local, no timezone configured)`
      );
    }

    let unsubscribeRealtime: (() => void) | undefined;
    if (this.botState) {
      unsubscribeRealtime = this.botState.subscribeToRemoteStop(() => {
        console.log(`${this.logPrefix} Stop received from dashboard → stopping loop.`);
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
          if (this.isStandby) {
            await sleep(STANDBY_POLL_MS);
            continue;
          }
          cycleCount += 1;

          if (this.botState) {
            const status = await this.botState.getStatus().catch((err) => {
              if (isLikelyDatabaseDown(err)) {
                this.isStandby = true;
                logger.warn(`${this.logPrefix} Database seems down while reading status; entering standby mode`, {
                  ...toErrorDetails(err),
                });
                return 'RUNNING';
              }
              throw err;
            });
            if (status === 'STOPPED') {
              console.log(`${this.logPrefix} Stop received from dashboard → stopping loop.`);
              this.isRunning = false;
              break;
            }
          }

          let filters: BotFilters = this.filters;
          if (this.botState) {
            const raw = await this.botState.getFilters().catch((err) => {
              if (isLikelyDatabaseDown(err)) {
                this.isStandby = true;
                logger.warn(`${this.logPrefix} Database seems down while reading filters; entering standby mode`, {
                  ...toErrorDetails(err),
                });
                return this.filters as unknown as Record<string, unknown>;
              }
              throw err;
            });

            // Daily housekeeping: prune past blackout dates from DB (by bot timezone)
            if (this.botId) {
              const todayIso = getTodayIsoDateInTimezone(this.timezoneId);
              if (this.lastBlackoutPruneIsoDate !== todayIso) {
                this.lastBlackoutPruneIsoDate = todayIso;
                try {
                  const rawFiltersOnly: Record<string, unknown> = { ...(raw ?? {}) };
                  delete (rawFiltersOnly as any).working_hours;

                  const bo = (rawFiltersOnly as any).blackoutDates;
                  if (Array.isArray(bo) && bo.length > 0) {
                    const normalized = (bo as unknown[])
                      .flatMap((v) => (typeof v === 'string' ? [v.trim()] : []))
                      .filter(Boolean);
                    const pruned = normalized.filter((d) => d >= todayIso);

                    const changed =
                      pruned.length !== normalized.length ||
                      pruned.some((d, i) => d !== normalized[i]);

                    if (changed) {
                      (rawFiltersOnly as any).blackoutDates = pruned;
                      await getSupabase()
                        .from('bots')
                        .update({ filters: rawFiltersOnly })
                        .eq('id', this.botId);
                      console.log(
                        `${this.logPrefix} 🧹 Pruned blackoutDates in DB (kept ${pruned.length}, removed ${normalized.length - pruned.length}).`
                      );
                    }
                  }
                } catch (err) {
                  logger.warn('Failed to prune blackoutDates in DB', {
                    ...toErrorDetails(err),
                  });
                }
              }
            }

            filters = toBotFilters(raw);
            const filtersJson = JSON.stringify(filters);
            if (filtersJson !== lastFiltersJson) {
              lastFiltersJson = filtersJson;
            }
          }

          // Bot runs 24/7: working hours are enforced as an offer acceptance filter (in FilterEngine),
          // not as a loop sleep schedule. Coffee breaks are still applied below.

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
          // Reset proxy/network error counters once we successfully fetch offers.
          this.consecutiveNetworkProxyErrors = 0;
          this.consecutiveGatewayErrors = 0;
          requestCount += 1;
          const offers = getOffersList(data);
          const included = getIncludedList(data);
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

              const result = FilterEngine.isMatch(
                offer,
                filters,
                existingRides,
                included,
                this.timezoneId
              );

              if (result.match) {
                console.log(
                  `${this.logPrefix} ✅ Offer ${idStr} matched filters. Sending accept request...`
                );
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
                    .catch((err) => {
                      logger.warn(`${this.logPrefix} Failed to report match`, { ...toErrorDetails(err) });
                    });
                }
                try {
                  await this.api.acceptOffer(offer);
                } catch (acceptErr) {
                  // Keep bot alive on accept failures; notify webhook and continue loop.
                  // Only remove from processedOfferIds for transient errors (no status, 429, 5xx)
                  // so the offer can be retried. For 404/410, do NOT retry — offer won't become
                  // available and removing it causes an infinite accept loop.
                  const statusCode = extractHttpStatusCode(acceptErr);
                  const isTransient = !statusCode || statusCode === 429 || statusCode >= 500;
                  if (isTransient) {
                    this.processedOfferIds.delete(idStr);
                  }
                  const message =
                    acceptErr instanceof Error && acceptErr.message
                      ? acceptErr.message
                      : String(acceptErr);
                  const reason =
                    acceptErr instanceof InvalidOfferStateError
                      ? 'invalid_offer_state'
                      : 'accept_request_failed';

                  logger.warn(`${this.logPrefix} Accept request failed for offer ${idStr}`, {
                    offerId: idStr,
                    statusCode,
                    reason,
                    ...toErrorDetails(acceptErr),
                  });

                  if (!(acceptErr instanceof InvalidOfferStateError)) {
                    await triggerOfferAcceptErrorWebhook(
                      this.botEmail,
                      idStr,
                      message,
                      reason,
                      statusCode,
                      {
                        offerId: idStr,
                        statusCode,
                        ...toErrorDetails(acceptErr),
                      }
                    );
                  } else {
                    logger.info(
                      `${this.logPrefix} Skipping webhook for expected 410 invalid_state on offer ${idStr}.`
                    );
                  }

                  continue;
                }
                if (this.botId) {
                  try {
                    const { pickup, dropoff } = resolveOfferLocations(offer, included);
                    const pickupAddr = (pickup?.attributes as Record<string, unknown> | undefined)?.formatted_address_en;
                    const dropoffAddr = (dropoff?.attributes as Record<string, unknown> | undefined)?.formatted_address_en;
                    await getSupabase()
                      .from('accepted_offers')
                      .upsert(
                        {
                          bot_id: this.botId,
                          offer_id: idStr,
                          price: String(price),
                          pickup_at: pickupAt || null,
                          pickup_address: typeof pickupAddr === 'string' ? pickupAddr : null,
                          dropoff_address: typeof dropoffAddr === 'string' ? dropoffAddr : null,
                        },
                        { onConflict: 'bot_id,offer_id' }
                      );
                  } catch (err) {
                    logger.warn('Failed to log accepted offer to Supabase', {
                      ...toErrorDetails(err),
                    });
                  }
                }
                const rideDateTime = formatRideDateTime(pickupAt, this.timezoneId);
                console.log(
                  `${this.logPrefix} 🎯 Offer ${idStr} booked. Ride time: ${rideDateTime}. Entering cooldown before next scan...`
                );
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

          console.log(`${this.logPrefix} Cycle ${cycleCount}: ${offers.length} offer(s).`);

          if (this.botState && cycleCount % HEARTBEAT_INTERVAL_CYCLES === 0) {
            await this.botState.updateHeartbeat().catch((err) => {
              if (isLikelyDatabaseDown(err)) {
                this.isStandby = true;
                logger.warn(`${this.logPrefix} Database seems down during heartbeat; entering standby mode`, {
                  ...toErrorDetails(err),
                });
                return;
              }
              throw err;
            });
          }
          // Successful cycle => reset network/gateway/unknown error counters.
          this.consecutiveUnknownErrors = 0;
          this.consecutiveGatewayErrors = 0;
          this.consecutiveNetworkProxyErrors = 0;

          if (!this.isRunning) break;
          const { sniper_delay_min_ms, sniper_delay_max_ms } = await getGlobalSettings();
          await randomSleep(sniper_delay_min_ms, sniper_delay_max_ms);
        } catch (err) {
          if (err instanceof TokenExpiredError) {
            console.log(`${this.logPrefix} Session expired.`);
            if (this.botState) {
              await this.botState.saveSession({}).catch((saveErr) => {
                logger.warn(`${this.logPrefix} Failed to clear session after token expiry`, {
                  ...toErrorDetails(saveErr),
                });
              });
              await this.botState.updateStatus('ERROR_AUTH').catch((statusErr) => {
                logger.warn(`${this.logPrefix} Failed to set ERROR_AUTH after token expiry`, {
                  ...toErrorDetails(statusErr),
                });
              });
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
              `${this.logPrefix} Rate limit hit → pausing for ${backoffSeconds}s (resume at ${resumeAt.toLocaleTimeString()}, stop checked every 8s).`
            );
            if (this.botState) {
              await this.botState.updateStatus('PAUSED_RATE_LIMIT').catch((statusErr) => {
                logger.warn(`${this.logPrefix} Failed to set PAUSED_RATE_LIMIT`, {
                  ...toErrorDetails(statusErr),
                });
              });
            }

            while (Date.now() < rateLimitEnd && this.isRunning) {
              const remainingMs = rateLimitEnd - Date.now();
              const sleepMs = Math.min(STOP_CHECK_INTERVAL_MS, Math.max(0, remainingMs));
              if (sleepMs > 0) await sleep(sleepMs);

              if (this.botState) {
                const status = await this.botState.getStatus().catch((statusErr) => {
                  if (isLikelyDatabaseDown(statusErr)) {
                    this.isStandby = true;
                    logger.warn(`${this.logPrefix} Database seems down during rate-limit pause; entering standby mode`, {
                      ...toErrorDetails(statusErr),
                    });
                    return 'RUNNING';
                  }
                  throw statusErr;
                });
                if (status === 'STOPPED') {
                  console.log(`${this.logPrefix} Stop received from dashboard → stopping loop.`);
                  this.isRunning = false;
                  break;
                }
              }
            }

            if (!this.isRunning) break;
            console.log(`${this.logPrefix} Rate limit pause finished → resuming.`);
            const status = this.botState ? await this.botState.getStatus() : 'RUNNING';
            if (status !== 'STOPPED' && this.botState) {
              await this.botState.updateStatus('RUNNING').catch((statusErr) => {
                logger.warn(`${this.logPrefix} Failed to restore RUNNING after rate limit pause`, {
                  ...toErrorDetails(statusErr),
                });
              });
            }
          } else if (err instanceof InvalidOfferStateError) {
            this.consecutiveUnknownErrors = 0;
            const message = err instanceof Error && err.message ? err.message : 'invalid offer state (410)';
            console.log(
              `${this.logPrefix} Offer not accepted (invalid state / already taken). Continuing sniper loop. Detail: ${message}`
            );
            logger.info(
              `${this.logPrefix} Offer could not be accepted due to invalid state; continuing loop.`,
              {
                error: message,
              }
            );
          } else {
            const statusCode = extractHttpStatusCode(err);

            // Gateway policy: 502/503 => rotate and count 3 consecutive -> force re-auth, then keep going.
            if (statusCode === 502 || statusCode === 503) {
              this.consecutiveUnknownErrors = 0;
              this.consecutiveGatewayErrors += 1;
              this.consecutiveNetworkProxyErrors += 1;

              const delayMs = exponentialBackoffWithJitterMs(this.consecutiveNetworkProxyErrors);
              logger.warn(
                `${this.logPrefix} [GATEWAY] Proxy/route error (${statusCode}) → rotate (${this.consecutiveGatewayErrors}/3) and backoff ${delayMs}ms.`,
                {
                  ...toErrorDetails(err),
                  statusCode,
                  consecutiveGatewayErrors: this.consecutiveGatewayErrors,
                  consecutiveNetworkProxyErrors: this.consecutiveNetworkProxyErrors,
                }
              );

              this.api.rotateProxySession('gateway');

              if (this.consecutiveGatewayErrors >= 3) {
                throw new ReauthRequiredError('Gateway errors persisted after 3 proxy rotations');
              }

              await sleep(delayMs);
              continue;
            }

            // Soft network policy: timeouts/tunnel failures/etc => rotate and keep retrying forever with backoff.
            if (isSoftNetworkError(err, statusCode)) {
              this.consecutiveUnknownErrors = 0;
              this.consecutiveGatewayErrors = 0;
              this.consecutiveNetworkProxyErrors += 1;

              const delayMs = exponentialBackoffWithJitterMs(this.consecutiveNetworkProxyErrors);
              logger.warn(
                `${this.logPrefix} [NETWORK] Proxy/network issue (statusCode=${statusCode ?? 'n/a'}) → rotate and backoff ${delayMs}ms.`,
                {
                  ...toErrorDetails(err),
                  statusCode,
                  consecutiveNetworkProxyErrors: this.consecutiveNetworkProxyErrors,
                }
              );

              this.api.rotateProxySession(statusCode === 504 ? 'gateway' : 'tunnel');
              await sleep(delayMs);
              continue;
            }

            // Unknown errors: bounded retry then ERROR_AUTH (non-network errors).
            this.consecutiveGatewayErrors = 0;
            this.consecutiveUnknownErrors += 1;
            console.error(
              `${this.logPrefix} Erreur cycle (${this.consecutiveUnknownErrors}/${MAX_UNKNOWN_ERRORS_BEFORE_ERROR_AUTH}):`,
              toErrorDetails(err)
            );
            logger.error(`${this.logPrefix} Unhandled sniper cycle error`, {
              consecutiveUnknownErrors: this.consecutiveUnknownErrors,
              ...toErrorDetails(err),
            });

            if (this.consecutiveUnknownErrors < MAX_UNKNOWN_ERRORS_BEFORE_ERROR_AUTH) {
              logger.warn(`${this.logPrefix} Will retry unknown cycle error before marking ERROR_AUTH.`);
              continue;
            }

            if (this.botState) {
              await this.botState.updateStatus('ERROR_AUTH').catch((statusErr) => {
                logger.warn(`${this.logPrefix} Failed to set ERROR_AUTH after repeated unknown errors`, {
                  ...toErrorDetails(statusErr),
                });
              });
            }

            if (isLikelyDatabaseDown(err)) {
              this.isStandby = true;
              logger.warn(
                `${this.logPrefix} Database down detected in unknown error path; staying alive in standby`,
                {
                  ...toErrorDetails(err),
                }
              );
              continue;
            }

            throw err;
          }
        }
      }
    } catch (err) {
      if (isLikelyDatabaseDown(err)) {
        this.isStandby = true;
        logger.warn(`${this.logPrefix} Top-level DB error captured; keeping sniper alive in standby`, {
          ...toErrorDetails(err),
        });
        while (this.isRunning && this.isStandby) {
          await sleep(STANDBY_POLL_MS);
        }
        return;
      }

      const statusCode = extractHttpStatusCode(err);
      const isProxyOrNetwork =
        statusCode === 502 || statusCode === 503 || isSoftNetworkError(err, statusCode);
      if (this.botState && !isProxyOrNetwork) {
        await this.botState.updateStatus('ERROR_AUTH').catch((statusErr) => {
          logger.warn(`${this.logPrefix} Failed to set ERROR_AUTH in top-level sniper catch`, {
            ...toErrorDetails(statusErr),
          });
        });
      } else if (this.botState && isProxyOrNetwork) {
        logger.warn(`${this.logPrefix} Top-level proxy/network error: skipping ERROR_AUTH status update.`, {
          ...toErrorDetails(err),
          statusCode,
        });
      }
      throw err;
    } finally {
      unsubscribeRealtime?.();
    }
  }
}

export class ReauthRequiredError extends Error {
  constructor(message = 'Re-auth required') {
    super(message);
    this.name = 'ReauthRequiredError';
    Object.setPrototypeOf(this, ReauthRequiredError.prototype);
  }
}

export default SniperLoop;
