/**
 * Manual test script for AuthService (loginAndGetToken).
 * Run with: npx ts-node src/scripts/test-auth-manual.ts
 * Or: npm run build && node dist/scripts/test-auth-manual.js
 * Requires .env with BLACKLANE_EMAIL and BLACKLANE_PASSWORD.
 */

import 'dotenv/config';
import { loginAndGetToken } from '../core/auth';

const TOKEN_PREVIEW_LENGTH = 20;

async function main(): Promise<void> {
  console.log('Starting Auth Test...');

  const email = process.env.BLACKLANE_EMAIL;
  const password = process.env.BLACKLANE_PASSWORD;

  if (!email || !password) {
    console.error('Missing BLACKLANE_EMAIL or BLACKLANE_PASSWORD in .env');
    process.exit(1);
  }

  try {
    const result = await loginAndGetToken(email, password);

    console.log('SUCCESS: Token found!');
    const tokenPreview =
      result.accessToken.length > TOKEN_PREVIEW_LENGTH
        ? `${result.accessToken.slice(0, TOKEN_PREVIEW_LENGTH)}...`
        : result.accessToken;
    console.log('Access Token (first 20 chars):', tokenPreview);
    console.log('Cookies found:', result.cookies.length);
  } catch (err) {
    console.error('FAILED: Full error object:', err);
    process.exit(1);
  }
}

main();
