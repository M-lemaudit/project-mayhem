/**
 * Test script: fetch upcoming bookings (agenda) from Blacklane API.
 * Run: npm run build && npm run test:bookings
 * Requires .env: BLACKLANE_EMAIL, BLACKLANE_PASSWORD, BLACKLANE_API_URL.
 */

import 'dotenv/config';
import { loginAndGetToken } from '../core/auth';
import { BlacklaneApi } from '../services';

async function main(): Promise<void> {
  console.log('Fetching upcoming bookings (agenda)...\n');

  const email = process.env.BLACKLANE_EMAIL;
  const password = process.env.BLACKLANE_PASSWORD;
  if (!email || !password) {
    console.error('Missing BLACKLANE_EMAIL or BLACKLANE_PASSWORD in .env');
    process.exit(1);
  }

  try {
    const { accessToken, cookies, userAgent } = await loginAndGetToken(email, password);
    const api = new BlacklaneApi(
      accessToken,
      cookies,
      userAgent,
      process.env.BLACKLANE_USER_ID ?? ''
    );
    const bookings = await api.getUpcomingBookings();

    console.log(`📅 Nombre de réservations à venir: ${bookings.length}\n`);
    if (bookings.length === 0) {
      console.log('Aucune course à venir (ou endpoint /hades/bookings vide).');
      console.log('Ces données alimentent la table Supabase "rides" et le filtre time-gap.');
      return;
    }
    for (const b of bookings) {
      console.log(`  id: ${b.id}`);
      console.log(`  start: ${b.start_at}`);
      console.log(`  end:   ${b.end_at}`);
      console.log(`  status: ${b.status}`);
      console.log(`  pickup:  ${b.pickup}`);
      console.log(`  dropoff: ${b.dropoff}`);
      console.log('  ---');
    }
  } catch (err) {
    console.error('Erreur:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
