# Blacklane Sniper V2 - Technical Roadmap

## Phase 0: Initialization & Environment
- [x] Initialize Git repository.
- [x] Setup Node.js project (TypeScript, ESLint, Prettier).
- [x] Configure Docker environment (`Dockerfile`, `docker-compose.yml`).
- [x] Setup Supabase project (Remote or Local).
    - [x] Create `bots` table (id, email, status, filters, session, last_seen, created_at).
    - [x] Enable Realtime on `bots` table.

## Phase 1: Authentication Module (The Key)
- [x] Implement Playwright Stealth setup (removing `navigator.webdriver`, etc.).
- [x] Create `AuthService`:
    - [x] Logic: Navigate to Login -> Input Creds -> Handle Captcha/Errors.
    - [x] **Constraint:** Fail-fast if login fails (Status: `ERROR_AUTH`). No 2FA handling needed.
- [x] Create `SessionManager` (BotStateService):
    - [x] Extract `access_token` and `cookies` (via network interception in auth).
    - [x] Store session in Supabase `session` column.
    - [x] Logic to restore session from DB on cold start (Zero-Touch fast login).

## Phase 2: The Sniper Engine (The Gun)
- [x] **BlacklaneApi** HTTP client:
    - [x] Axios with `https.Agent({ keepAlive: true })`, browser-like headers (Accept, Origin, Referer, sec-ch-ua, etc.).
    - [x] `GET /hades/offers` with params (`page[number]`, `page[size]`, `include`).
    - [x] `POST /hades/offers/:id/accept`.
    - [x] 401 → `TokenExpiredError`, 429 → `RateLimitError`.
- [x] Implement `SniperLoop` (Node.js native loop, NO Browser):
    - [x] Setup Axios instance with `https.Agent({ keepAlive: true })` for low latency (in BlacklaneApi).
    - [x] Polling logic: `GET /hades/offers` every 1000-2000ms (randomized).
    - [x] Error Handling: Manage 401 (Token Expired) -> Trigger Re-Auth (clear session, exit).
    - [x] Error Handling: Manage 429 (Rate Limit) -> 5 min backoff, status PAUSED_RATE_LIMIT.
- [x] Implement `FilterEngine`:
    - [x] In-memory comparison of offer JSON vs Config JSON.
    - [x] Logic: `minPrice`, `allowedVehicleTypes`, `minHoursFromNow`.
- [x] Implement `ActionService`:
    - [x] API method: `POST /hades/offers/{id}/accept` (in BlacklaneApi).
    - [x] Sniper logic: call accept when offer matches filters.
    - [ ] **Optimization:** Reduce artificial delay to compensate for Miami <-> EU latency if needed (target total latency < 400ms).

## Phase 3: Admin & Orchestration
- [x] Build Minimal Admin Dashboard (Next.js):
    - [x] View list of bots with live status (Green/Red).
    - [x] Edit Bot Config (Filters) via JSON Editor.
    - [x] "Kill Switch" button (updates status to STOPPED).
- [x] Implement `BotOrchestrator`:
    - [x] Bot process listens to Supabase Realtime `UPDATE` events.
    - [x] If status changes to `STOPPED` in DB -> Process.exit(0).
    - [x] If filters change -> Fetch from DB each cycle (dynamic filters).

## Phase 4: Infrastructure & Deployment
- [ ] Optimize Docker Image (Multi-stage build, minimal footprint).
- [ ] Setup ISP Proxy integration (Static IP Miami).
- [ ] Deploy to AWS `us-east-1` (EC2 t3.medium or similar).
- [ ] Setup PM2/Docker Restart policies for 24/7 uptime.

## Phase 5: Security & Hardening
- [ ] Audit for memory leaks in the polling loop.
- [ ] Verify TLS Fingerprinting consistency (Ja3/Ja4).