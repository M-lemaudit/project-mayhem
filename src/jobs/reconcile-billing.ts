/**
 * Standalone billing reconciliation job. Iterates EVERY bot (running or not — billing must
 * not depend on a bot being live), authenticates via the saved session (zero-touch when still
 * valid), fetches finished rides, and stamps the matching accepted_offers as billable.
 *
 * Run: npm run reconcile   (cron this daily; the 3% fee is computed at read time in the admin UI)
 *
 * Requires .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY), BLACKLANE_API_URL.
 */

import 'dotenv/config';
import { getSupabase } from '../config/supabase';
import { loginAndGetToken, discoverUserProfile, type SavedSession } from '../core/auth';
import { BlacklaneApi, BillingReconciler } from '../services';
import { decrypt, looksEncrypted } from '../utils/crypto';
import { logger } from '../utils';

interface BotRow {
  id: string;
  email: string;
  password: string | null;
  blacklane_user_id: string | null;
  session: Record<string, unknown> | null;
  timezone: string | null;
  locale: string | null;
}

function resolvePassword(raw: string | null): string {
  if (!raw || typeof raw !== 'string') throw new Error('Password missing for bot');
  return looksEncrypted(raw) ? decrypt(raw) : raw;
}

async function reconcileBot(bot: BotRow): Promise<number> {
  const supabase = getSupabase();
  const password = resolvePassword(bot.password);
  const browserOptions =
    bot.timezone?.trim() || bot.locale?.trim()
      ? {
          ...(bot.timezone?.trim() && { timezoneId: bot.timezone.trim() }),
          ...(bot.locale?.trim() && { locale: bot.locale.trim() }),
        }
      : undefined;

  const session = await loginAndGetToken(
    bot.email,
    password,
    (bot.session as SavedSession) ?? undefined,
    browserOptions
  );

  let blacklaneUserId = bot.blacklane_user_id ?? '';
  let bdId: string | undefined;
  let lspId: string | undefined;
  const profile = await discoverUserProfile(session.accessToken);
  if (profile) {
    if (!blacklaneUserId) blacklaneUserId = profile.userId;
    bdId = profile.bdId;
    lspId = profile.lspId;
  }
  if (!blacklaneUserId) {
    throw new Error(`blacklane_user_id missing for ${bot.email} and auto-discovery failed.`);
  }

  const api = new BlacklaneApi(
    bot.email,
    session.accessToken,
    session.cookies,
    session.userAgent,
    blacklaneUserId,
    bdId,
    lspId
  );
  const { matched } = await new BillingReconciler(supabase, bot.id).reconcile(api);
  return matched;
}

async function main(): Promise<void> {
  logger.info('[reconcile] Starting billing reconciliation for all bots...');
  const supabase = getSupabase();
  const { data: bots, error } = await supabase
    .from('bots')
    .select('id, email, password, blacklane_user_id, session, timezone, locale');

  if (error) {
    logger.error(`[reconcile] Failed to load bots: ${error.message}`);
    process.exit(1);
  }
  const rows = (bots ?? []) as BotRow[];
  logger.info(`[reconcile] ${rows.length} bot(s) to process.`);

  let totalMatched = 0;
  for (const bot of rows) {
    try {
      const matched = await reconcileBot(bot);
      totalMatched += matched;
    } catch (err) {
      // One bot's auth/network failure must not abort the whole run.
      logger.warn(`[reconcile] Bot ${bot.email} failed`, {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info(`[reconcile] Done. ${totalMatched} offer(s) newly marked as completed/billable.`);
  process.exit(0);
}

main();
