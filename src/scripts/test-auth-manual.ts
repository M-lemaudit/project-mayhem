/**
 * Manual test script for AuthService (loginAndGetToken).
 * Run with: npm run test:auth  (builds then runs dist/scripts/test-auth-manual.js)
 * Requires .env with BLACKLANE_EMAIL and BLACKLANE_PASSWORD.
 * Token is captured via network interception (Authorization header).
 */

import 'dotenv/config';
import { loginAndGetToken } from '../core/auth';

const TOKEN_PREVIEW_LENGTH = 20;
const SEP = '────────────────────────────────────────';

async function main(): Promise<void> {
  console.log('Starting Auth Test...');
  console.log(SEP);

  const email = process.env.BLACKLANE_EMAIL;
  const password = process.env.BLACKLANE_PASSWORD;

  if (!email || !password) {
    console.error('Missing BLACKLANE_EMAIL or BLACKLANE_PASSWORD in .env');
    process.exit(1);
  }

  try {
    const result = await loginAndGetToken(email, password);

    console.log(SEP);
    console.log('SUCCESS: Token captured from network!');
    const tokenPreview =
      result.accessToken.length > TOKEN_PREVIEW_LENGTH
        ? `${result.accessToken.slice(0, TOKEN_PREVIEW_LENGTH)}...`
        : result.accessToken;
    console.log('Access Token (first 20 chars):', tokenPreview);
    console.log('Cookies found:', result.cookies.length);
    console.log(SEP);
  } catch (err) {
    console.error(SEP);
    console.error('FAILED: Full error object:', err);
    console.error(SEP);
    process.exit(1);
  }
}

main();
