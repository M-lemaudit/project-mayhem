# Blacklane Sniper Admin Dashboard

Minimal admin UI to monitor and control sniper bots.

## Setup

1. Copy `.env.local.example` to `.env.local`
2. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (same as root `.env` SUPABASE_URL and SUPABASE_KEY)
3. Run `npm install`
4. Run `npm run dev` — dashboard at http://localhost:3001

## Features

- **Live status** — Green (RUNNING), Gray (STOPPED), Red (ERROR/PAUSED)
- **Edit Filters** — JSON editor to update `minPrice`, `allowedVehicleTypes`, etc.
- **Kill Switch** — Stop a running bot remotely (updates status to STOPPED; bot exits via Realtime)
