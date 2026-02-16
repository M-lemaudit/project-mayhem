/**
 * Blacklane Sniper V2 - Entry point.
 * Loads env, initializes connections (Supabase singleton), then starts orchestration.
 */

import 'dotenv/config';
import { loadConfig, getSupabase } from './config';
import { logger } from './utils';

function main(): void {
  const config = loadConfig();
  logger.info('Blacklane Sniper V2 starting', {
    nodeEnv: config.NODE_ENV,
    blacklaneApiUrl: config.BLACKLANE_API_URL,
  });

  getSupabase();
  logger.debug('Supabase client initialized');

  // TODO: Pull bot config from Supabase, start SniperLoop, subscribe to Realtime STOP.
  logger.info('Blacklane Sniper V2 - Ready (skeleton)');
}

main();
