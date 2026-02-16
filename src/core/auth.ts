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
/** Time to wait for a request with Authorization: Bearer after clicking login. */
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/** URL pattern for Blacklane auth API (token visible in Network tab). */
const ATHENA_HOST = 'athena.blacklane.com';
const BEARER_PREFIX = 'Bearer ';

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

/** Debug dump from Deep Inspection mode (do not fail when token not in known keys). */
export interface DeepInspectionDebug {
  localStorageKeys: string[];
  sessionStorageKeys: string[];
  cookieNames: string[];
  potentialTokenKeys: string[];
  rawLocalStorage: Record<string, string>;
  rawSessionStorage: Record<string, string>;
}

export interface AuthResult {
  accessToken: string;
  cookies: AuthCookie[];
  userAgent: string;
  /** Set when Deep Inspection ran (token may be null; inspect debug and logs). */
  debug?: DeepInspectionDebug;
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
 * Normalize Authorization header to raw token (strip "Bearer " prefix).
 */
function normalizeBearerToken(authHeader: string | undefined): string {
  if (!authHeader || typeof authHeader !== 'string') return '';
  const trimmed = authHeader.trim();
  return trimmed.startsWith(BEARER_PREFIX) ? trimmed.slice(BEARER_PREFIX.length) : trimmed;
}

/**
 * Log in to Blacklane partner portal and return access token + cookies.
 * Token is captured via network interception (Authorization header), not from storage.
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

    logger.info('Network listener: waiting for request with Authorization header');
    const tokenPromise = page.waitForRequest(
      (request) => {
        const url = request.url();
        const headers = request.headers();
        const auth = headers['authorization'] ?? headers['Authorization'];
        const hasAthena = url.includes(ATHENA_HOST);
        const hasBearer = typeof auth === 'string' && auth.startsWith(BEARER_PREFIX);
        return (hasAthena && !!auth) || hasBearer;
      },
      { timeout: TOKEN_REQUEST_TIMEOUT_MS }
    );

    await page.click(submitSelector, { timeout: 5_000 });

    let request;
    try {
      request = await tokenPromise;
    } catch {
      const currentUrl = page.url();
      if (currentUrl.includes('/login')) {
        throw new AuthError('Login did not complete; still on login page', 'INVALID_CREDENTIALS');
      }
      throw new AuthError(
        `No request with Authorization header within ${TOKEN_REQUEST_TIMEOUT_MS}ms (check athena.blacklane.com or Bearer in Network tab)`,
        'TOKEN_NOT_FOUND'
      );
    }
    const authHeader = request.headers()['authorization'] ?? request.headers()['Authorization'];
    const accessToken = normalizeBearerToken(authHeader);
    if (!accessToken) {
      throw new AuthError(
        'Request had no Authorization header or empty Bearer token',
        'TOKEN_NOT_FOUND'
      );
    }
    logger.info('Token captured from network', { url: request.url() });

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
    logger.info('Cookies captured', { count: authCookies.length });

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
