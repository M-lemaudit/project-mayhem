/**
 * AuthService: stealth browser login to Blacklane and extraction of Bearer token + cookies.
 * Fail-fast on auth failure; no retry. Used by SessionManager upstream.
 */

import type { Page } from 'playwright-core';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { logger } from '../utils';

const stealth = StealthPlugin();
chromium.use(stealth);

const LOGIN_URL = 'https://partner.blacklane.com/login';
const LOGIN_TIMEOUT_MS = 60_000;
const POST_LOGIN_WAIT_MS = 15_000;

/** Known localStorage keys where Blacklane may store the Bearer token. */
const TOKEN_KEYS = ['bl_auth_token', 'access_token', 'token', 'auth', 'session'];

/** Serializable cookie shape for storage and reuse in API client. */
export interface AuthCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface AuthResult {
  accessToken: string;
  cookies: AuthCookie[];
  userAgent: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: 'TIMEOUT' | 'INVALID_CREDENTIALS' | 'TOKEN_NOT_FOUND' | 'NAVIGATION' = 'NAVIGATION'
  ) {
    super(message);
    this.name = 'AuthError';
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

function randomDelayMs(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function humanType(page: Page, selector: string, value: string): Promise<void> {
  await page.fill(selector, '');
  for (const char of value) {
    await page.locator(selector).pressSequentially(char, {
      delay: randomDelayMs(50, 120),
    });
  }
}

/**
 * Extract Bearer token from localStorage dump.
 * Tries known keys and parses JSON values for nested token fields.
 */
function findAccessToken(localStorageDump: Record<string, string>): string | null {
  for (const key of TOKEN_KEYS) {
    const raw = localStorageDump[key];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const trimmed = raw.trim();
    if (trimmed.length > 20 && !trimmed.startsWith('{')) {
      return trimmed;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.access_token === 'string') return parsed.access_token;
      if (typeof parsed.token === 'string') return parsed.token;
      if (typeof parsed.accessToken === 'string') return parsed.accessToken;
    } catch {
      if (trimmed.length > 20) return trimmed;
    }
  }
  return null;
}

/**
 * Log in to Blacklane partner portal and return access token + cookies.
 * Closes the browser before returning. Throws AuthError on failure.
 */
export async function loginAndGetToken(
  email: string,
  password: string
): Promise<AuthResult> {
  logger.info('Browser launch (stealth)', { headless: false });
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      userAgent: undefined,
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: false,
    });
    const page = await context.newPage();

    logger.info('Navigating to login', { url: LOGIN_URL });
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT_MS });

    const emailSelector = 'input[name="email"], input[type="email"], input[id*="email"]';
    const passwordSelector = 'input[name="password"], input[type="password"], input[id*="password"]';
    await page.waitForSelector(emailSelector, { timeout: 10_000 });
    await page.waitForSelector(passwordSelector, { timeout: 10_000 });

    logger.info('Credentials entered');
    await humanType(page, emailSelector, email);
    await delay(randomDelayMs(200, 500));
    await humanType(page, passwordSelector, password);

    const submitSelector =
      'button[type="submit"], input[type="submit"], [data-testid*="login"], button:has-text("Log in"), button:has-text("Sign in")';
    await page.click(submitSelector, { timeout: 5_000 });

    await delay(2_000);

    try {
      await Promise.race([
        page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: POST_LOGIN_WAIT_MS }),
        page.waitForSelector('button:has-text("Logout"), [data-logout], [href*="logout"], [class*="dashboard"]', {
          timeout: POST_LOGIN_WAIT_MS,
        }),
      ]);
    } catch {
      const currentUrl = page.url();
      if (currentUrl.includes('/login')) {
        throw new AuthError('Login did not complete; still on login page', 'INVALID_CREDENTIALS');
      }
    }

    logger.info('Token extraction (localStorage + cookies)');
    /* eslint-disable no-undef -- runs in browser context */
    const localStorageDump = await page.evaluate((): Record<string, string> => {
      const out: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) out[key] = localStorage.getItem(key) ?? '';
      }
      return out;
    });
    /* eslint-enable no-undef */

    const accessToken = findAccessToken(localStorageDump);
    if (!accessToken) {
      const keys = Object.keys(localStorageDump);
      logger.warn('Token not in known keys; localStorage keys', { keys });
      throw new AuthError(
        `Bearer token not found in localStorage (checked: ${TOKEN_KEYS.join(', ')})`,
        'TOKEN_NOT_FOUND'
      );
    }

    const cookies = await context.cookies();
    const authCookies: AuthCookie[] = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite as AuthCookie['sameSite'],
    }));

    const userAgent = await page.evaluate((): string => {
      /* eslint-disable-next-line no-undef -- runs in browser context */
      return navigator.userAgent;
    });

    logger.info('Token extracted successfully');
    return {
      accessToken,
      cookies: authCookies,
      userAgent,
    };
  } finally {
    await browser.close();
    logger.debug('Browser closed');
  }
}
