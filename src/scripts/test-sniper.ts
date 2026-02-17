/**
 * Test the sniper loop in SIMULATION MODE.
 * Only "accepts" (mock) offers whose pickup is in more than 36 hours (UTC).
 * Run: npm run test:sniper
 * Requires .env: BLACKLANE_EMAIL, BLACKLANE_PASSWORD, BLACKLANE_API_URL.
 */

import 'dotenv/config';
import { loginAndGetToken } from '../core/auth';
import { SniperLoop, type BotFilters } from '../core';
import { BlacklaneApi } from '../services';

const MIN_HOURS_FROM_NOW = 36;

async function main(): Promise<void> {
  console.log('Starting Sniper test (SIMULATION – no real accept)...');
  console.log(`Filter: only offers with pickup in more than ${MIN_HOURS_FROM_NOW}h from now (UTC).\n`);

  const email = process.env.BLACKLANE_EMAIL;
  const password = process.env.BLACKLANE_PASSWORD;
  if (!email || !password) {
    console.error('Missing BLACKLANE_EMAIL or BLACKLANE_PASSWORD in .env');
    process.exit(1);
  }

  try {
    const { accessToken, cookies, userAgent } = await loginAndGetToken(email, password);
    const api = new BlacklaneApi(accessToken, cookies, userAgent);

    const filters: BotFilters = {
      minPrice: 0,
      allowedVehicleTypes: [],
      minHoursFromNow: MIN_HOURS_FROM_NOW,
    };

    const sniper = new SniperLoop(api, filters);
    await sniper.start();
  } catch (err) {
    console.error('FAILED:', err);
    process.exit(1);
  }
}

main();
