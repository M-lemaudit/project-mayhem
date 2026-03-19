/**
 * AuthService: stealth browser login to Blacklane and extraction of Bearer token + cookies.
 * Fail-fast on auth failure; no retry. Used by SessionManager upstream.
 */

import type { Page } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { logger } from '../utils';
import { decrypt, looksEncrypted } from '../utils/crypto';

const stealth = StealthPlugin();
chromium.use(stealth);

const LOGIN_URL = 'https://partner.blacklane.com/login';
const LOGIN_TIMEOUT_MS = 60_000;
/** Time to wait for a request with Authorization: Bearer after clicking login. */
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/** French chauffeur laptop: Europe/Paris timezone, fr-FR locale. */
const BROWSER_TIMEZONE_ID = 'Europe/Paris';
const BROWSER_LOCALE = 'fr-FR';

/** Consistent Chrome on Windows 10/11 User-Agent (avoids headless/bot detection). */
const CHROME_WINDOWS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** URL pattern for Blacklane auth API (token visible in Network tab). */
const ATHENA_HOST = 'athena.blacklane.com';
const BEARER_PREFIX = 'Bearer ';
/** Fallback Accept when browser does not send it in the captured request. */
const DEFAULT_ACCEPT = 'application/vnd.blacklane.v2+json';

function generateRandomSessionId(length = 8): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const alphabetSize = alphabet.length;
  const maxUnbiased = Math.floor(256 / alphabetSize) * alphabetSize; // 248 for base62

  let result = '';
  while (result.length < length) {
    const bytes = crypto.randomBytes(Math.max(16, length));
    for (const byte of bytes) {
      if (byte >= maxUnbiased) continue;
      result += alphabet[byte % alphabetSize];
      if (result.length >= length) break;
    }
  }
  return result;
}

function getDynamicProxyUrl(baseProxyUrl: string): string {
  const url = new URL(baseProxyUrl);
  const sessionRegex = /(session-)[A-Za-z0-9]+/;
  const decodedUsername = url.username ? decodeURIComponent(url.username) : '';
  const decodedPassword = url.password ? decodeURIComponent(url.password) : '';

  if (decodedUsername && sessionRegex.test(decodedUsername)) {
    url.username = decodedUsername.replace(sessionRegex, `$1${generateRandomSessionId()}`);
  } else if (decodedPassword && sessionRegex.test(decodedPassword)) {
    url.password = decodedPassword.replace(sessionRegex, `$1${generateRandomSessionId()}`);
  } else {
    // Fallback: rotate if session token appears elsewhere in the URL string.
    return baseProxyUrl.replace(sessionRegex, `$1${generateRandomSessionId()}`);
  }
  return url.toString();
}

function getProxySessionLabel(proxyUrlOrCreds: string | undefined): string | undefined {
  if (!proxyUrlOrCreds) return undefined;
  const match = proxyUrlOrCreds.match(/session-[A-Za-z0-9]+/);
  return match?.[0];
}

function getPlaywrightProxyFromUrl(proxyUrl: string):
  | {
      server: string;
      username?: string;
      password?: string;
    }
  | undefined {
  try {
    const url = new URL(proxyUrl);
    if (!url.hostname) return undefined;

    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const server = `http://${url.hostname}:${port}`;

    const username = url.username ? decodeURIComponent(url.username) : '';
    const password = url.password ? decodeURIComponent(url.password) : '';

    return {
      server,
      ...(username && { username }),
      ...(password && { password }),
    };
  } catch {
    return undefined;
  }
}

function getPlaywrightProxyFromEnv():
  | {
      server: string;
      username?: string;
      password?: string;
    }
  | undefined {
  const raw = process.env.PROXY_URL?.trim();
  if (!raw) return undefined;

  try {
    const url = new URL(raw);
    if (!url.hostname) return undefined;

    const port =
      url.port || (url.protocol === 'https:' ? '443' : '80');
    const server = `http://${url.hostname}:${port}`;

    const username = url.username ? decodeURIComponent(url.username) : '';
    const password = url.password ? decodeURIComponent(url.password) : '';

    logger.debug('[NETWORK] Using proxy for Playwright login', { server });

    return {
      server,
      ...(username && { username }),
      ...(password && { password }),
    };
  } catch (error) {
    logger.warn('Failed to parse PROXY_URL for Playwright. Proceeding without proxy.', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

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
  /** Browser's User-Agent string (from navigator.userAgent), for API request consistency. */
  userAgent: string;
  /** Exact Accept header from the captured athena request (fixes 406). */
  acceptHeader: string;
  /** From request header x-blacklane-context (if present). */
  xBlacklaneContext?: string;
  /** From request header x-device-id (if present). */
  xDeviceId?: string;
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

/** Minimal session shape stored in Supabase. Used for Zero-Touch fast login. */
export interface SavedSession {
  accessToken?: string;
  cookies?: AuthCookie[];
  userAgent?: string;
  acceptHeader?: string;
  xBlacklaneContext?: string;
  xDeviceId?: string;
}

/**
 * Check if a saved session has accessToken AND cookies. Assume valid if both present.
 */
export function isSavedSessionUsable(saved: unknown): saved is SavedSession {
  if (!saved || typeof saved !== 'object') return false;
  const obj = saved as Record<string, unknown>;
  const token = obj.accessToken;
  const cookies = obj.cookies;
  return (
    typeof token === 'string' &&
    token.trim().length > 0 &&
    Array.isArray(cookies)
  );
}

async function captureLoginErrorScreenshot(page: Page, email: string): Promise<string | undefined> {
  try {
    const screenshotsDir = path.join(process.cwd(), 'login-error');
    await fs.promises.mkdir(screenshotsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeEmail = email.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${timestamp}-${safeEmail}.png`;
    const fullPath = path.join(screenshotsDir, fileName);
    await page.screenshot({ path: fullPath, fullPage: true });
    logger.error(`[AUTH] Saved login error screenshot for ${email} at ${fullPath}`);
    return fullPath;
  } catch (err) {
    logger.warn('[AUTH] Failed to capture login error screenshot', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Reconstruct AuthResult from a saved session. Call only when isSavedSessionUsable is true.
 */
function savedSessionToAuthResult(saved: SavedSession): AuthResult {
  return {
    accessToken: saved.accessToken!,
    cookies: Array.isArray(saved.cookies) ? (saved.cookies as AuthCookie[]) : [],
    userAgent: typeof saved.userAgent === 'string' ? saved.userAgent : '',
    acceptHeader: typeof saved.acceptHeader === 'string' ? saved.acceptHeader : DEFAULT_ACCEPT,
    ...(saved.xBlacklaneContext && { xBlacklaneContext: saved.xBlacklaneContext }),
    ...(saved.xDeviceId && { xDeviceId: saved.xDeviceId }),
  };
}

/** Optional browser fingerprint overrides (from bot config in DB). */
export interface AuthBrowserOptions {
  /** IANA timezone (e.g. Europe/Paris, America/New_York). */
  timezoneId?: string;
  /** Locale (e.g. fr-FR, en-US). */
  locale?: string;
}

/**
 * Log in to Blacklane partner portal and return access token + cookies.
 * Credentials come only from arguments (Fleet Manager passes per-bot email/password from DB).
 * Step A: If savedSession has accessToken AND cookies → return immediately (no browser).
 * Step B: Otherwise, fallback to Playwright browser login with email + password.
 * Step C: Returns { accessToken, cookies, userAgent, acceptHeader }.
 * @param browserOptions - Optional timezone/locale from bot (Stealth Settings). Defaults: Europe/Paris, fr-FR.
 */
export async function loginAndGetToken(
  email: string,
  password: string,
  savedSession?: unknown,
  browserOptions?: AuthBrowserOptions
): Promise<AuthResult> {
  if (isSavedSessionUsable(savedSession)) {
    logger.info(`[AUTH] Using saved session for ${email} (skipping Playwright login)`);
    return savedSessionToAuthResult(savedSession);
  }

  const timezoneId =
    browserOptions?.timezoneId?.trim() || BROWSER_TIMEZONE_ID;
  const locale = browserOptions?.locale?.trim() || BROWSER_LOCALE;

  const maxAttempts = 3;
  let lastError: unknown;
  let invalidLoginAttempts = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const baseProxyUrl = process.env.PROXY_URL?.trim();
    const localProxyUrl = baseProxyUrl ? getDynamicProxyUrl(baseProxyUrl) : undefined;
    const proxy = localProxyUrl ? getPlaywrightProxyFromUrl(localProxyUrl) : undefined;
    const sessionLabel = localProxyUrl ? getProxySessionLabel(localProxyUrl) : undefined;
    if (localProxyUrl && sessionLabel) {
      logger.info(
        `[AUTH] Using proxy ${sessionLabel} for ${email} (Attempt ${attempt + 1}/${maxAttempts}) — ${localProxyUrl}`
      );
    }
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let page: Page | undefined;

    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled'],
        ...(proxy && { proxy }),
      });

      const context = await browser.newContext({
        userAgent: CHROME_WINDOWS_USER_AGENT,
        locale,
        timezoneId,
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: false,
      });
      page = await context.newPage();

      const response = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT_MS });
      const status = response?.status();
      if (status === 502) {
        throw new Error(`Blacklane login returned ${status}`);
      }

      const emailSelector = 'input[name="email"], input[type="email"], input[id*="email"]';
      const passwordSelector = 'input[name="password"], input[type="password"], input[id*="password"]';
      await page.waitForSelector(emailSelector, { timeout: 10_000 });
      await page.waitForSelector(passwordSelector, { timeout: 10_000 });

      const plainPassword = looksEncrypted(password) ? decrypt(password) : password;

      await humanType(page, emailSelector, email);
      await delay(randomDelayMs(200, 500));
      await humanType(page, passwordSelector, plainPassword);

      const submitSelector =
        'button[type="submit"], input[type="submit"], [data-testid*="login"], button:has-text("Log in"), button:has-text("Sign in")';

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
      const headers = request.headers();
      const authHeader = headers['authorization'] ?? headers['Authorization'];
      const accessToken = normalizeBearerToken(authHeader);
      if (!accessToken) {
        throw new AuthError(
          'Request had no Authorization header or empty Bearer token',
          'TOKEN_NOT_FOUND'
        );
      }
      const acceptHeader =
        (headers['accept'] ?? headers['Accept'] ?? '').trim() || DEFAULT_ACCEPT;
      const xBlacklaneContext = (headers['x-blacklane-context'] ?? '').trim() || undefined;
      const xDeviceId = (headers['x-device-id'] ?? '').trim() || undefined;
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
      /* eslint-disable-next-line no-undef -- runs in browser context */
      const userAgent = await page.evaluate(() => navigator.userAgent);

      return {
        accessToken,
        cookies: authCookies,
        userAgent,
        acceptHeader,
        ...(xBlacklaneContext && { xBlacklaneContext }),
        ...(xDeviceId && { xDeviceId }),
      };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);

      const isTunnelOrProxyError =
        message.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
        message.includes('ERR_PROXY_CONNECTION_FAILED');
      const isGatewayError = /\b502\b/.test(message);

      if (error instanceof AuthError && error.code === 'INVALID_CREDENTIALS') {
        invalidLoginAttempts += 1;
        if (invalidLoginAttempts >= 2 && page) {
          await captureLoginErrorScreenshot(page, email);
        }
        if (invalidLoginAttempts < 2 && attempt + 1 < maxAttempts) {
          logger.warn(
            `[AUTH] Login stuck on page for ${email}. Retrying Playwright login (Attempt ${
              attempt + 2
            }/${maxAttempts})...`
          );
          continue;
        }
        throw error;
      }

      const shouldRetry = isTunnelOrProxyError || isGatewayError;
      if (!shouldRetry || attempt + 1 >= maxAttempts) {
        throw error;
      }

      logger.warn(
        `[AUTH] Proxy tunnel failed for ${email}. Rotating IP (Attempt ${attempt + 2}/${maxAttempts})...`
      );
      continue;
    } finally {
      if (browser) {
        await browser.close();
        logger.debug('Browser closed');
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Automatically fetch the Blacklane User ID using the acquired session token.
 * This calls the partner portal /me endpoint and extracts the root-level `id`.
 */
export async function discoverBlacklaneUserId(
  accessToken: string
): Promise<string | undefined> {
  try {
    const response = await fetch('https://partner-portal-api.blacklane.com/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      logger.warn('[AUTH] User ID auto-discovery request failed', {
        status: response.status,
        statusText: response.statusText,
      });
      return undefined;
    }
    const data = await response.json() as { id?: unknown };
    const id = data?.id;
    if (typeof id === 'string' && id.trim().length > 0) {
      return id;
    }
    if (typeof id === 'number' && Number.isFinite(id)) {
      return String(id);
    }
  } catch (err) {
    logger.warn('[AUTH] Error during auto-discovery of User ID', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  return undefined;
}
