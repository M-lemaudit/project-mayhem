/**
 * Configuration loader. Loads dotenv and exposes validated env vars.
 * Fail-fast: missing required vars crash on first access.
 */

import dotenv from 'dotenv';

dotenv.config();

export interface EnvConfig {
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  PROXY_URL: string | undefined;
  BLACKLANE_API_URL: string;
  NODE_ENV: string;
}

function getEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`Missing required env: ${key}`);
  }
  return value;
}

function getEnvOptional(key: string): string | undefined {
  return process.env[key];
}

/** Validated config. Access after dotenv is loaded. */
export function loadConfig(): EnvConfig {
  return {
    SUPABASE_URL: getEnv('SUPABASE_URL'),
    SUPABASE_KEY: getEnv('SUPABASE_KEY'),
    PROXY_URL: getEnvOptional('PROXY_URL'),
    BLACKLANE_API_URL: getEnv('BLACKLANE_API_URL'),
    NODE_ENV: getEnvOptional('NODE_ENV') ?? 'development',
  };
}
