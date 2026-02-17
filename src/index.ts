/**
 * Blacklane Sniper V2 - Entry point (daemon).
 * Le processus reste en vie. Il attend que le statut soit RUNNING (bouton Start dans l’admin),
 * puis lance auth + boucle sniper. Stop dans l’admin arrête la boucle ; le processus repasse en attente.
 */

import 'dotenv/config';
import { loginAndGetToken } from './core/auth';
import { SniperLoop, type BotFilters } from './core';
import { BlacklaneApi, BotStateService } from './services';
import { logger } from './utils';

const POLL_INTERVAL_MS = 10_000; // quand STOPPED, vérifier le statut toutes les 10 s

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function runSniperSession(
  email: string,
  password: string,
  botState: BotStateService
): Promise<void> {
  console.log('[BOT] Connexion Blacklane + session...');
  const savedSession = await botState.getSession();
  const session = await loginAndGetToken(email, password, savedSession);
  await botState.saveSession({
    accessToken: session.accessToken,
    cookies: session.cookies,
    userAgent: session.userAgent,
    acceptHeader: session.acceptHeader,
    ...(session.xBlacklaneContext && { xBlacklaneContext: session.xBlacklaneContext }),
    ...(session.xDeviceId && { xDeviceId: session.xDeviceId }),
  });

  const api = new BlacklaneApi(session.accessToken, session.cookies, session.userAgent);
  const rawFilters = await botState.getFilters();
  const filters: BotFilters = {
    minPrice: typeof rawFilters.minPrice === 'number' ? rawFilters.minPrice : 10,
    allowedVehicleTypes: Array.isArray(rawFilters.allowedVehicleTypes)
      ? (rawFilters.allowedVehicleTypes as string[])
      : [],
    ...(typeof rawFilters.maxPrice === 'number' && { maxPrice: rawFilters.maxPrice }),
    ...(typeof rawFilters.minHoursFromNow === 'number' && { minHoursFromNow: rawFilters.minHoursFromNow }),
  };

  console.log('[BOT] Sniper démarré (Stop = dashboard).');
  const sniper = new SniperLoop(api, filters, botState);
  await sniper.start();
  console.log('[BOT] Sniper arrêté, en attente du statut.\n');
}

async function main(): Promise<void> {
  const email = process.env.BLACKLANE_EMAIL;
  const password = process.env.BLACKLANE_PASSWORD;
  if (!email || !password) {
    console.error('[BOT] ❌ Erreur: BLACKLANE_EMAIL ou BLACKLANE_PASSWORD manquant dans .env');
    process.exit(1);
  }

  const botState = new BotStateService(email);

  const shutdown = (): void => {
    console.log('\n[BOT] Ctrl+C → STOPPED, exit.');
    botState
      .updateStatus('STOPPED')
      .catch((err) => logger.error('Failed to update status on shutdown', { err }))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    console.log('\n[BOT] Blacklane Sniper (simulation). Démarrez le bot, puis Start dans l’admin.\n');
    await botState.initialize();

    for (;;) {
      const status = await botState.getStatus();

      if (status !== 'RUNNING') {
        console.log(`[BOT] Statut: ${status} (attente ${POLL_INTERVAL_MS / 1000}s)`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      console.log('[BOT] RUNNING → lancement session.\n');
      try {
        await runSniperSession(email, password, botState);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[BOT] Erreur:', message);
        await botState.updateStatus('ERROR_AUTH').catch(() => {});
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[BOT] Fatal:', message);
    process.exit(1);
  }
}

main();
