# Blacklane Sniper V2 - Technical Roadmap

## Phase 0: Initialization & Environment
- [ ] Initialize Git repository.
- [ ] Setup Node.js project (TypeScript, ESLint, Prettier).
- [ ] Configure Docker environment (`Dockerfile`, `docker-compose.yml`).
- [ ] Setup Supabase project (Remote or Local).
    - [ ] Create `bots` table (id, client_name, credentials, filters, session_state, status).
    - [ ] Enable Realtime on `bots` table.

## Phase 1: Authentication Module (The Key)
- [ ] Implement Playwright Stealth setup (removing `navigator.webdriver`, etc.).
- [ ] Create `AuthService`:
    - [ ] Logic: Navigate to Login -> Input Creds -> Handle Captcha/Errors.
    - [ ] **Constraint:** Fail-fast if login fails (Status: `ERROR_AUTH`). No 2FA handling needed.
- [ ] Create `SessionManager`:
    - [ ] Extract `access_token` and `cookies`.
    - [ ] Store session in Supabase `session_state` column.
    - [ ] Logic to restore session from DB on cold start.

## Phase 2: The Sniper Engine (The Gun)
- [ ] Implement `SniperLoop` (Node.js native loop, NO Browser):
    - [ ] Setup Axios instance with `https.Agent({ keepAlive: true })` for low latency.
    - [ ] Polling logic: `GET /hades/offers` every 800-1200ms (randomized).
    - [ ] Error Handling: Manage 401 (Token Expired) -> Trigger Re-Auth.
    - [ ] Error Handling: Manage 429 (Rate Limit) -> Exponential Backoff.
- [ ] Implement `FilterEngine`:
    - [ ] In-memory comparison of offer JSON vs Config JSON.
    - [ ] Logic: `min_price`, `zones`, `blacklist`.
- [ ] Implement `ActionService`:
    - [ ] Logic: `POST /hades/offers/{id}/accept`.
    - [ ] **Optimization:** Reduce artificial delay to compensate for Miami <-> EU latency if needed (target total latency < 400ms).

## Phase 3: Admin & Orchestration
- [ ] Build Minimal Admin Dashboard (Next.js):
    - [ ] View list of bots with live status (Green/Red).
    - [ ] Edit Bot Config (Filters/Creds) via JSON Editor.
    - [ ] "Kill Switch" button (updates status to STOPPED).
- [ ] Implement `BotOrchestrator`:
    - [ ] Bot process listens to Supabase Realtime `UPDATE` events.
    - [ ] If status changes to `STOPPED` in DB -> Process.exit(0).
    - [ ] If filters change -> Update local memory variable immediately.

## Phase 4: Infrastructure & Deployment
- [ ] Optimize Docker Image (Multi-stage build, minimal footprint).
- [ ] Setup ISP Proxy integration (Static IP Miami).
- [ ] Deploy to AWS `us-east-1` (EC2 t3.medium or similar).
- [ ] Setup PM2/Docker Restart policies for 24/7 uptime.

## Phase 5: Security & Hardening
- [ ] Audit for memory leaks in the polling loop.
- [ ] Verify TLS Fingerprinting consistency (Ja3/Ja4).