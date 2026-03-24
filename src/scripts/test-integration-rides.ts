/**
 * Integration test: auth → ride sync (getPlannedRides + pagination) → upsert → Supabase.
 * Run: npm run build && npm run test:integration-rides
 *
 * Requires:
 * - .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)
 * - .env: BLACKLANE_EMAIL, BLACKLANE_PASSWORD, BLACKLANE_API_URL (or a RUNNING bot in DB)
 * - At least one bot with status RUNNING in Supabase (bots table).
 *
 * If BLACKLANE_EMAIL/PASSWORD are set, the script uses the first RUNNING bot in DB
 * for bot_id only and uses these credentials to login (useful when bot password is encrypted).
 * Otherwise it uses the first RUNNING bot's email/password.
 */

import 'dotenv/config';
import { getSupabase } from '../config/supabase';
import { loginAndGetToken } from '../core/auth';
import { BlacklaneApi, RideSyncService } from '../services';
import { decrypt, looksEncrypted } from '../utils/crypto';

interface BotRow {
  id: string;
  email: string;
  password: string | null;
}

function resolvePassword(raw: string | null): string {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Password missing for bot');
  }
  return looksEncrypted(raw) ? decrypt(raw) : raw;
}

async function main(): Promise<void> {
  console.log('Integration test: Ride sync (API → Supabase)\n');

  const supabase = getSupabase();
  const { data: bots, error: botErr } = await supabase
    .from('bots')
    .select('id, email, password')
    .eq('status', 'RUNNING')
    .limit(1);

  if (botErr) {
    console.error('Supabase bots query failed:', botErr.message);
    process.exit(1);
  }
  const bot = (bots && bots[0]) as BotRow | undefined;
  if (!bot) {
    console.error(
      'Aucun bot avec status RUNNING en base. Créez un bot et passez-le en RUNNING (dashboard admin) pour ce test.'
    );
    process.exit(1);
  }

  const useEnvCredentials = process.env.BLACKLANE_EMAIL && process.env.BLACKLANE_PASSWORD;
  const email = useEnvCredentials ? process.env.BLACKLANE_EMAIL! : bot.email;
  const password = useEnvCredentials ? process.env.BLACKLANE_PASSWORD! : resolvePassword(bot.password);

  console.log(`Bot: ${bot.email} (id: ${bot.id})`);
  if (useEnvCredentials) console.log('Using BLACKLANE_EMAIL / BLACKLANE_PASSWORD from .env\n');

  try {
    const { accessToken, cookies, userAgent } = await loginAndGetToken(email, password);
    const api = new BlacklaneApi(
      email,
      accessToken,
      cookies,
      userAgent,
      process.env.BLACKLANE_USER_ID ?? ''
    );
    const rideSync = new RideSyncService(supabase, bot.id);
    await rideSync.sync(api);

    const { data: rows, error: rideErr } = await supabase
      .from('rides')
      .select('id')
      .eq('bot_id', bot.id);
    if (rideErr) {
      console.error('Supabase rides query failed:', rideErr.message);
      process.exit(1);
    }
    const count = rows?.length ?? 0;
    console.log(`\n✅ Sync OK. Rides en base pour ce bot: ${count}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error && err.stack ? err.stack : undefined;
    console.error('Erreur:', { errorMessage, errorStack });
    process.exit(1);
  }
}

main();
