/**
 * Blacklane Sniper V2 - Fleet Manager.
 * Manages multiple bots dynamically. Queries Supabase for RUNNING bots,
 * starts/stops SniperLoop instances accordingly.
 */

import 'dotenv/config';
import { loginAndGetToken } from './core/auth';
import { SniperLoop, type BotFilters } from './core';
import { BlacklaneApi, BotStateService, RideSyncService } from './services';
import { logger } from './utils';
import { getSupabase } from './config/supabase';
import { decrypt, looksEncrypted } from './utils/crypto';

const proxyUrl = process.env.PROXY_URL?.trim();
if (proxyUrl) {
  console.log('[NETWORK] Proxy enabled: Routing traffic through IP Royal.');
}

const WATCHDOG_INTERVAL_MS = 10_000;
const RIDE_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface RunningBotRow {
  id: string;
  email: string;
  password: string | null;
  timezone: string | null;
  locale: string | null;
  filters: Record<string, unknown>;
  session: Record<string, unknown>;
   /** Blacklane internal user id used for authenticated API actions (e.g. accept offer). */
  blacklane_user_id: string | null;
}

/** Fetches all bots with status RUNNING from Supabase. */
async function fetchActiveBots(): Promise<RunningBotRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('bots')
    .select('id, email, password, timezone, locale, filters, session, blacklane_user_id')
    .eq('status', 'RUNNING');

  if (error) {
    logger.error('Fleet: failed to fetch active bots', { error: error.message });
    return [];
  }

  return (data ?? []) as RunningBotRow[];
}

/** Resolves plaintext password (decrypt if encrypted). */
function resolvePassword(raw: string | null): string {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Password missing for bot');
  }
  return looksEncrypted(raw) ? decrypt(raw) : raw;
}

/** Runs a single bot's sniper session. Fire-and-forget. */
async function runBotInstance(
  bot: RunningBotRow,
  instances: Map<string, SniperLoop>,
  pendingStarts: Set<string>
): Promise<void> {
  const { email } = bot;
  const prefix = () => `[${email}]`;
  pendingStarts.add(email);
  let rideSyncInterval: ReturnType<typeof setInterval> | undefined;

  try {
    const password = resolvePassword(bot.password);
    const botState = new BotStateService(email);

    const browserOptions =
      (bot.timezone?.trim() || bot.locale?.trim())
        ? {
            ...(bot.timezone?.trim() && { timezoneId: bot.timezone.trim() }),
            ...(bot.locale?.trim() && { locale: bot.locale.trim() }),
          }
        : undefined;
    logger.info(`${prefix()} Connecting to Blacklane...`);
    const savedSession = await botState.getSession();
    const session = await loginAndGetToken(email, password, savedSession, browserOptions);

    await botState.saveSession({
      accessToken: session.accessToken,
      cookies: session.cookies,
      userAgent: session.userAgent,
      acceptHeader: session.acceptHeader,
      ...(session.xBlacklaneContext && { xBlacklaneContext: session.xBlacklaneContext }),
      ...(session.xDeviceId && { xDeviceId: session.xDeviceId }),
    });

    const blacklaneUserId = bot.blacklane_user_id;
    if (!blacklaneUserId) {
      throw new Error('blacklane_user_id is missing for bot ' + email);
    }

    const api = new BlacklaneApi(session.accessToken, session.cookies, session.userAgent, blacklaneUserId);
    const rawFilters = await botState.getFilters();
    const filters: BotFilters = {
      minPrice: typeof rawFilters.minPrice === 'number' ? rawFilters.minPrice : 10,
      allowedVehicleTypes: Array.isArray(rawFilters.allowedVehicleTypes)
        ? (rawFilters.allowedVehicleTypes as string[])
        : [],
      ...(typeof rawFilters.maxPrice === 'number' && { maxPrice: rawFilters.maxPrice }),
      ...(typeof rawFilters.minHoursFromNow === 'number' && {
        minHoursFromNow: rawFilters.minHoursFromNow,
      }),
    };

    const supabase = getSupabase();
    const rideSync = new RideSyncService(supabase, bot.id);
    await rideSync.sync(api);
    rideSyncInterval = setInterval(() => {
      rideSync.sync(api).catch(() => {});
    }, RIDE_SYNC_INTERVAL_MS);

    logger.info(`${prefix()} Sniper started (Stop = dashboard).`);
    const timezoneId = bot.timezone?.trim() || undefined;
    const sniper = new SniperLoop(api, filters, botState, email, bot.id, timezoneId);
    instances.set(email, sniper);

    await sniper.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`${prefix()} Error:`, { err: message });
    try {
      const botState = new BotStateService(email);
      await botState.updateStatus('ERROR_AUTH');
    } catch {
      /* ignore */
    }
  } finally {
    if (rideSyncInterval != null) clearInterval(rideSyncInterval);
    pendingStarts.delete(email);
    instances.delete(email);
    logger.info(`${prefix()} Sniper stopped.`);
  }
}

/** Bot IDs that were RUNNING in the previous sync. Used to only start when status actually changed to RUNNING (user turned ON). */
let prevRunningBotIds = new Set<string>();

async function syncFleet(
  instances: Map<string, SniperLoop>,
  pendingStarts: Set<string>
): Promise<void> {
  const active = await fetchActiveBots();
  const activeEmails = new Set(active.map((b) => b.email));
  const activeIds = new Set(active.map((b) => b.id));

  for (const [email, sniper] of instances) {
    if (!activeEmails.has(email)) {
      logger.info(`[${email}] Stopping (no longer RUNNING in DB).`);
      sniper.stop();
    }
  }

  for (const bot of active) {
    const alreadyRunning = instances.has(bot.email) || pendingStarts.has(bot.email);
    const wasAlreadyRunningLastSync = prevRunningBotIds.has(bot.id);
    if (!alreadyRunning && !wasAlreadyRunningLastSync) {
      logger.info(`[${bot.email}] Starting sniper (status changed to RUNNING).`);
      runBotInstance(bot, instances, pendingStarts);
    }
  }

  prevRunningBotIds = activeIds;
}

async function runFleet(): Promise<void> {
  const instances = new Map<string, SniperLoop>();
  const pendingStarts = new Set<string>();

  const shutdown = (): void => {
    logger.info('Fleet: Shutting down, stopping all bots...');
    for (const [email, sniper] of instances) {
      sniper.stop();
      logger.info(`[${email}] Stop requested.`);
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Fleet Manager started. Watching for RUNNING bots every 10s.');
  await syncFleet(instances, pendingStarts);

  setInterval(() => {
    syncFleet(instances, pendingStarts);
  }, WATCHDOG_INTERVAL_MS);
}

runFleet().catch((err) => {
  logger.error('Fleet Manager fatal:', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
