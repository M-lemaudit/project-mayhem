/**
 * Test script: fetch planned rides (with pagination) from Blacklane API.
 * Run: npm run build && npm run test:planned-rides
 * Requires .env: BLACKLANE_EMAIL, BLACKLANE_PASSWORD, BLACKLANE_API_URL.
 */

import 'dotenv/config';
import { loginAndGetToken } from '../core/auth';
import { BlacklaneApi } from '../services';

async function main(): Promise<void> {
  console.log('Fetching planned rides (all pages)...\n');

  const email = process.env.BLACKLANE_EMAIL;
  const password = process.env.BLACKLANE_PASSWORD;
  if (!email || !password) {
    console.error('Missing BLACKLANE_EMAIL or BLACKLANE_PASSWORD in .env');
    process.exit(1);
  }

  try {
    const { accessToken, cookies, userAgent } = await loginAndGetToken(email, password);
    const api = new BlacklaneApi(
      email,
      accessToken,
      cookies,
      userAgent,
      process.env.BLACKLANE_USER_ID ?? ''
    );
    const rides = await api.getPlannedRides();

    console.log(`📅 Total planned rides (toutes pages): ${rides.length}\n`);
    if (rides.length === 0) {
      console.log('Aucune course planifiée (ou endpoint /hades/rides vide).');
      return;
    }
    const toShow = rides.slice(0, 5);
    for (const r of toShow) {
      console.log(`  id: ${r.id}`);
      console.log(`  start: ${r.start_at}`);
      console.log(`  end:   ${r.end_at}`);
      console.log(`  status: ${r.status}`);
      console.log('  ---');
    }
    if (rides.length > 5) {
      console.log(`  ... et ${rides.length - 5} autres.\n`);
    }
  } catch (err) {
    console.error('Erreur:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
