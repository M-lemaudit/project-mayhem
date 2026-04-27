# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Blacklane Sniper V2 — a fleet manager that runs multiple bot instances to automate ride acceptance via Blacklane's partner API. Each bot logs in via Playwright (headless Chromium), extracts auth tokens/cookies, closes the browser, then enters a polling "hot loop" using HTTP clients with the extracted session.

## Commands

- **Build:** `npm run build` (runs `tsc`, outputs to `dist/`)
- **Typecheck:** `npm run typecheck` (`tsc --noEmit`)
- **Lint:** `npm run lint` / `npm run lint:fix`
- **Format:** `npm run format` / `npm run format:check`
- **Start bot:** `npm start` (runs `node dist/index.js`)
- **Admin UI dev:** `npm run admin:dev` (Next.js on port 3001)
- **Test scripts** (build + run, no test framework):
  - `npm run test:auth` — manual auth test
  - `npm run test:offers` — fetch offers
  - `npm run test:sniper` — sniper loop
  - `npm run test:bookings` / `test:planned-rides` / `test:integration-rides` / `test:gap`
- **Docker:** `docker-compose up` (builds from Dockerfile, uses `.env`)

## Architecture

**Entry point:** `src/index.ts` — Fleet Manager. Polls Supabase every 10s for bots with status `RUNNING`, starts/stops `SniperLoop` instances accordingly. Handles database standby mode, proxy/network errors, and auth error escalation.

**Core layer** (`src/core/`):
- `auth.ts` — Playwright stealth login to `partner.blacklane.com`, extracts Bearer token + cookies + user-agent. Session reuse if saved session is still valid.
- `sniper-loop.ts` — The hot loop: polls offers via API, filters with `FilterEngine`, calls `acceptOffer` on match. Handles rate limits (429), token expiry (401), gateway errors (502/503 with 3-rotation policy then re-auth), and network errors with exponential backoff.
- `filter-engine.ts` — In-memory offer filtering: price range, vehicle types, ride type, airport direction, airline blocklist, city blocklists, time gaps between rides, working hours, blackout dates, date ranges.

**Services** (`src/services/`):
- `blacklane-api.ts` — HTTP client for Blacklane API (offers, accept, bookings, planned rides). Uses `got-scraping` with proxy support and session rotation.
- `bot-state.ts` — Supabase CRUD for bot status, session, filters, heartbeat, match reporting. Subscribes to Realtime for remote STOP commands.
- `ride-sync.ts` — Periodic sync of upcoming rides to Supabase `rides` table (used for time-gap filtering).

**Config** (`src/config/`):
- `env.ts` — Dotenv loader with fail-fast validation
- `supabase.ts` — Supabase client singleton
- `global-settings.ts` — Global settings from Supabase (polling delays, etc.)

**Admin UI** (`admin/`): Next.js (React) dashboard on port 3001 with Supabase SSR auth. Manages bot configuration, start/stop, and monitoring.

## Key Environment Variables

See `.env.example`. Required: `SUPABASE_URL`, `SUPABASE_KEY`, `BLACKLANE_API_URL`. Set `IS_PRODUCTION=true` for real API calls (default is simulation mode).

## Coding Conventions

- TypeScript strict mode. No `any` (enforced by tsconfig). Define interfaces for all API responses.
- Fail-fast on auth errors — no endless retries.
- HTTP calls use `keepAlive` agents for latency reduction.
- Minimal logging in the hot loop; structured JSON logs (winston) for lifecycle events.
- Comments explain WHY, not WHAT. Prefer functional patterns.
- `allowedAirlines`, `allowedPickupCities`, `allowedDropoffCities` are actually **blocklists** despite their names (historical naming).
