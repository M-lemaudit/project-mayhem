/**
 * Test script: fetch finished rides (status finished,no_show, all pages) from Blacklane API.
 * Used to validate the /hades/finished_rides endpoint/params/auth before wiring reconciliation.
 * Run: npm run test:finished-rides
 * Requires .env: BLACKLANE_EMAIL, BLACKLANE_PASSWORD, BLACKLANE_API_URL.
 */

import 'dotenv/config';
import { loginAndGetToken } from '../core/auth';
import { BlacklaneApi } from '../services';

async function main(): Promise<void> {
  console.log('Fetching finished rides (all pages)...\n');

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
    const rides = await api.getFinishedRides();

    console.log(`🏁 Total finished rides (toutes pages): ${rides.length}\n`);
    if (rides.length === 0) {
      console.log('Aucune course terminée (ou endpoint /hades/finished_rides vide).');
      return;
    }
    for (const r of rides.slice(0, 5)) {
      console.log(`  rideUuid:      ${r.rideUuid}`);
      console.log(`  bookingNumber: ${r.bookingNumber}`);
      console.log(`  status:        ${r.status}`);
      console.log(`  price:         ${r.price} ${r.currency}`);
      console.log(`  startsAt:      ${r.startsAt.toISOString()}`);
      console.log(`  acceptedAt:    ${r.acceptedAt ? r.acceptedAt.toISOString() : '—'}`);
      console.log(`  passenger:     ${r.passengerName}`);
      console.log('  ---');
    }
    if (rides.length > 5) {
      console.log(`  ... et ${rides.length - 5} autres.\n`);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error && err.stack ? err.stack : undefined;
    console.error('Erreur:', { errorMessage, errorStack });
    process.exit(1);
  }
}

main();
