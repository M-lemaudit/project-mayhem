/**
 * Manual script: login (token + userAgent), then fetch offers via BlacklaneApi.
 * Run: npm run build && node dist/scripts/test-fetch-offers.js
 * Requires .env: BLACKLANE_EMAIL, BLACKLANE_PASSWORD, BLACKLANE_API_URL.
 */

import 'dotenv/config';
import { loginAndGetToken } from '../core/auth';
import { BlacklaneApi } from '../services';

function getOffersList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.offers)) return obj.offers;
    if (Array.isArray(obj.data)) return obj.data;
  }
  return [];
}

async function main(): Promise<void> {
  console.log('Starting Reconnaissance...');

  const email = process.env.BLACKLANE_EMAIL;
  const password = process.env.BLACKLANE_PASSWORD;
  if (!email || !password) {
    console.error('Missing BLACKLANE_EMAIL or BLACKLANE_PASSWORD in .env');
    process.exit(1);
  }

  try {
    const { accessToken, cookies, userAgent } = await loginAndGetToken(email, password);
    const api = new BlacklaneApi(accessToken, cookies, userAgent);
    const data = await api.getOffers();
    const offers = getOffersList(data);

    console.log('\n========== RÉPONSE BRUTE API OFFERS ==========');
    console.log('Type de data:', Array.isArray(data) ? 'array' : data && typeof data === 'object' ? 'object' : typeof data);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      console.log('Clés racine:', Object.keys(obj).join(', '));
    }
    console.log('Nombre d\'offres extraites:', offers.length);
    console.log('--- Réponse complète (data) ---');
    console.log(JSON.stringify(data, null, 2));
    if (offers.length > 0) {
      console.log('\n--- Première offre (détail) ---');
      console.log(JSON.stringify(offers[0], null, 2));
      const o = offers[0] as Record<string, unknown>;
      if (o && typeof o === 'object' && o.attributes) {
        console.log('\n--- offer.attributes (si JSON:API) ---');
        console.log(JSON.stringify(o.attributes, null, 2));
      }
    }
    console.log('================================================\n');

    if (offers.length === 0) {
      console.log('Authentication works, but no offers available right now.');
    }
  } catch (err) {
    console.error('FAILED:', err);
    process.exit(1);
  }
}

main();
