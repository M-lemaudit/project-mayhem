/**
 * Blacklane Sniper V2 - Fleet Manager.
 * Manages multiple bots dynamically. Queries Supabase for RUNNING bots,
 * starts/stops SniperLoop instances accordingly.
 */

import 'dotenv/config';
import { AuthError, loginAndGetToken, discoverBlacklaneUserId } from './core/auth';
import { ReauthRequiredError, SniperLoop, type BotFilters } from './core';
import { BlacklaneApi, BotStateService, RideSyncService } from './services';
import { isLikelyDatabaseDown, logger, toErrorDetails, triggerAuthErrorWebhook } from './utils';
import { getSupabase } from './config/supabase';
import { decrypt, looksEncrypted } from './utils/crypto';

const proxyUrl = process.env.PROXY_URL?.trim();
if (proxyUrl) {
  console.log('[NETWORK] Proxy enabled: Routing traffic through IP Royal.');
}

const WATCHDOG_INTERVAL_MS = 10_000;
const RIDE_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_IMMEDIATE_FATAL_ERRORS = 2;
const DB_PING_INTERVAL_MS = 30_000;

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
type ActiveBotsResult =
  | { ok: true; bots: RunningBotRow[] }
  | { ok: false; error: Error };

async function fetchActiveBots(): Promise<ActiveBotsResult> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('bots')
    .select('id, email, password, timezone, locale, filters, session, blacklane_user_id')
    .eq('status', 'RUNNING');

  if (error) {
    return { ok: false, error: new Error(`Fleet: failed to fetch active bots: ${error.message}`) };
  }

  return { ok: true, bots: (data ?? []) as RunningBotRow[] };
}

async function pingSupabaseLight(): Promise<boolean> {
  try {
    const { error } = await getSupabase()
      .from('bots')
      .select('id', { head: true, count: 'exact' })
      .limit(1);
    return !error;
  } catch {
    return false;
  }
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
  pendingStarts: Set<string>,
  getIsDatabaseDown: () => boolean,
  onDatabaseDown: (err: unknown) => void
): Promise<void> {
  const { email } = bot;
  const prefix = () => `[${email}]`;
  pendingStarts.add(email);
  let rideSyncInterval: ReturnType<typeof setInterval> | undefined;

  const password = resolvePassword(bot.password);
  const botState = new BotStateService(email);

  const browserOptions =
    (bot.timezone?.trim() || bot.locale?.trim())
      ? {
          ...(bot.timezone?.trim() && { timezoneId: bot.timezone.trim() }),
          ...(bot.locale?.trim() && { locale: bot.locale.trim() }),
        }
      : undefined;

  let reauthAttempts = 0;
  const maxReauthAttempts = 1;
  let consecutiveImmediateFatalErrors = 0;

  try {
    while (true) {
      try {
        if (getIsDatabaseDown()) {
          logger.warn(`${prefix()} Database standby active; waiting before starting/restarting bot instance.`);
          await new Promise((resolve) => setTimeout(resolve, DB_PING_INTERVAL_MS));
          continue;
        }
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

        let blacklaneUserId = bot.blacklane_user_id;

        if (!blacklaneUserId) {
          const discoveredId = await discoverBlacklaneUserId(session.accessToken);
          if (discoveredId) {
            blacklaneUserId = discoveredId;
            logger.info(`[AUTH] Auto-discovered Blacklane User ID: ${discoveredId}`);
            const supabase = getSupabase();
            await supabase
              .from('bots')
              .update({ blacklane_user_id: discoveredId })
              .eq('id', bot.id);
          }
        }

        if (!blacklaneUserId) {
          throw new Error('blacklane_user_id is missing for bot ' + email + ' and auto-discovery failed.');
        }

        const api = new BlacklaneApi(
          email,
          session.accessToken,
          session.cookies,
          session.userAgent,
          blacklaneUserId
        );
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
          rideSync.sync(api).catch((syncError) => {
            logger.warn(`${prefix()} RideSync interval failed`, {
              ...toErrorDetails(syncError),
            });
          });
        }, RIDE_SYNC_INTERVAL_MS);

        logger.info(`${prefix()} Sniper started (Stop = dashboard).`);
        const timezoneId = bot.timezone?.trim() || undefined;
        const sniper = new SniperLoop(api, filters, botState, email, bot.id, timezoneId);
        instances.set(email, sniper);

        await sniper.start();
        consecutiveImmediateFatalErrors = 0;
        break;
      } catch (err) {
        if (rideSyncInterval != null) clearInterval(rideSyncInterval);
        rideSyncInterval = undefined;
        instances.delete(email);

        if (isLikelyDatabaseDown(err)) {
          onDatabaseDown(err);
          logger.warn(`${prefix()} Database down detected in bot instance; parking in standby`, {
            ...toErrorDetails(err),
          });
          await new Promise((resolve) => setTimeout(resolve, DB_PING_INTERVAL_MS));
          continue;
        }

        if (err instanceof ReauthRequiredError && reauthAttempts < maxReauthAttempts) {
          reauthAttempts += 1;
          logger.warn(
            `${prefix()} Gateway persisted → attempting Playwright re-auth (Attempt ${reauthAttempts}/${maxReauthAttempts})`
          );
          await botState.saveSession({}).catch((saveErr) => {
            logger.warn(`${prefix()} Failed to clear session during reauth`, { ...toErrorDetails(saveErr) });
          });
          continue;
        }

        consecutiveImmediateFatalErrors += 1;
        const message = err instanceof Error ? err.message : String(err);
        const errorLog =
          err instanceof Error
            ? (err.stack ? `${err.name}: ${err.message}\n${err.stack}` : `${err.name}: ${err.message}`)
            : String(err);
        const errorLogDisplay = errorLog
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
          .replace(/\\/g, '/');
        const errorLogLines = errorLogDisplay.split('\n').filter((l) => l.trim().length > 0);
        logger.error(`${prefix()} Error in bot instance`, {
          botId: bot.id,
          email,
          consecutiveImmediateFatalErrors,
          ...toErrorDetails(err),
        });
        const shouldMarkErrorNow = consecutiveImmediateFatalErrors >= MAX_IMMEDIATE_FATAL_ERRORS;

        if (!shouldMarkErrorNow) {
          logger.warn(
            `${prefix()} Immediate fatal error attempt ${consecutiveImmediateFatalErrors}/${MAX_IMMEDIATE_FATAL_ERRORS}; retrying before marking bot as error.`
          );
          continue;
        }

        if (err instanceof AuthError && err.code === 'INVALID_CREDENTIALS') {
          if (!getIsDatabaseDown()) {
            await botState.updateStatus('STOPPED').catch((statusErr) => {
              logger.warn(`${prefix()} Failed to set STOPPED status`, { ...toErrorDetails(statusErr) });
            });
          } else {
            logger.warn(`${prefix()} Skipping STOPPED status update because database is down.`);
          }
        } else {
          if (!getIsDatabaseDown()) {
            await botState.updateStatus('ERROR_AUTH').catch((statusErr) => {
              logger.warn(`${prefix()} Failed to set ERROR_AUTH status`, { ...toErrorDetails(statusErr) });
            });
          } else {
            logger.warn(`${prefix()} Skipping ERROR_AUTH status update because database is down.`);
          }
        }
        let reason: Parameters<typeof triggerAuthErrorWebhook>[2] = 'unknown';
        let explanation: string | undefined;

        if (err instanceof ReauthRequiredError) {
          reason = 'gateway_persisted_after_rotation';
          explanation =
            'The bot kept receiving 502/503 gateway errors even after rotating proxy sessions, and the automatic re-auth attempt was exhausted.';
        } else if (err instanceof AuthError) {
          if (err.code === 'INVALID_CREDENTIALS') {
            reason = 'invalid_credentials';
            explanation = 'Login stayed on the Blacklane login page, indicating invalid credentials or blocked login.';
          } else if (err.code === 'TOKEN_NOT_FOUND') {
            reason = 'token_not_found';
            explanation =
              'Playwright login succeeded partially, but no Authorization token request was captured within the expected timeout.';
          } else {
            reason = 'playwright_navigation_failed';
            explanation = 'Playwright failed during navigation/login sequence.';
          }
        } else if (message.includes('ERR_TUNNEL_CONNECTION_FAILED') || message.includes('ERR_PROXY_CONNECTION_FAILED')) {
          reason = 'proxy_tunnel_failed';
          explanation = 'The proxy connection/tunnel failed (IPRoyal).';
        }

        await triggerAuthErrorWebhook(
          email,
          message,
          reason,
          explanation,
          errorLog,
          errorLogDisplay,
          errorLogLines
        );
        break;
      }
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
  pendingStarts: Set<string>,
  getIsDatabaseDown: () => boolean,
  onDatabaseDown: (err: unknown) => void
): Promise<void> {
  if (getIsDatabaseDown()) {
    logger.warn('Fleet: database in standby mode; skipping sync tick.');
    return;
  }
  const activeResult = await fetchActiveBots();
  if (!activeResult.ok) {
    if (isLikelyDatabaseDown(activeResult.error)) {
      throw activeResult.error;
    }
    logger.error('Fleet: skipping sync tick after Supabase polling failure', {
      ...toErrorDetails(activeResult.error),
    });
    return;
  }
  const active = activeResult.bots;
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
      runBotInstance(bot, instances, pendingStarts, getIsDatabaseDown, onDatabaseDown);
    }
  }

  prevRunningBotIds = activeIds;
}

async function syncFleetSafe(
  instances: Map<string, SniperLoop>,
  pendingStarts: Set<string>,
  getIsDatabaseDown: () => boolean,
  enterDatabaseStandby: (err: unknown) => void
): Promise<void> {
  try {
    await syncFleet(instances, pendingStarts, getIsDatabaseDown, enterDatabaseStandby);
  } catch (err) {
    if (isLikelyDatabaseDown(err)) {
      enterDatabaseStandby(err);
      return;
    }
    logger.error('Fleet: sync tick crashed', { ...toErrorDetails(err) });
  }
}

async function runFleet(): Promise<void> {
  const instances = new Map<string, SniperLoop>();
  const pendingStarts = new Set<string>();
  let isDatabaseDown = false;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const setStandbyForAllSnipers = (on: boolean): void => {
    for (const sniper of instances.values()) {
      sniper.setStandby(on);
    }
  };

  const exitDatabaseStandby = (): void => {
    isDatabaseDown = false;
    if (pingTimer != null) {
      clearInterval(pingTimer);
      pingTimer = undefined;
    }
    logger.info('Fleet: Supabase reachable again, leaving standby mode.');
    setStandbyForAllSnipers(false);
    void syncFleetSafe(
      instances,
      pendingStarts,
      () => isDatabaseDown,
      enterDatabaseStandby
    );
  };

  const enterDatabaseStandby = (err: unknown): void => {
    if (isDatabaseDown) return;
    isDatabaseDown = true;
    logger.error('Fleet: Supabase appears down, entering standby mode.', {
      ...toErrorDetails(err),
    });
    setStandbyForAllSnipers(true);
    if (pingTimer != null) return;
    pingTimer = setInterval(() => {
      void pingSupabaseLight().then((ok) => {
        if (ok) {
          exitDatabaseStandby();
        }
      });
    }, DB_PING_INTERVAL_MS);
  };

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
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection in fleet process', { ...toErrorDetails(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception in fleet process', { ...toErrorDetails(error) });
  });

  logger.info('Fleet Manager started. Watching for RUNNING bots every 10s.');
  await syncFleetSafe(instances, pendingStarts, () => isDatabaseDown, enterDatabaseStandby);

  setInterval(() => {
    void syncFleetSafe(instances, pendingStarts, () => isDatabaseDown, enterDatabaseStandby);
  }, WATCHDOG_INTERVAL_MS);
}

runFleet().catch((err) => {
  logger.error('Fleet Manager fatal:', { ...toErrorDetails(err) });
  process.exit(1);
});
