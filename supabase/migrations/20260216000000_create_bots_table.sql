-- =============================================================================
-- Blacklane Sniper V2: bots table
-- Stores bot instances with filters, session data, and heartbeat.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.bots (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'STOPPED' CHECK (status IN ('RUNNING', 'STOPPED', 'ERROR_AUTH')),
  filters    JSONB NOT NULL DEFAULT '{}',
  session    JSONB NOT NULL DEFAULT '{}',
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.bots ENABLE ROW LEVEL SECURITY;

-- Permissive policies (restrict later)
CREATE POLICY "bots_select_all" ON public.bots
  FOR SELECT USING (true);

CREATE POLICY "bots_insert_all" ON public.bots
  FOR INSERT WITH CHECK (true);

CREATE POLICY "bots_update_all" ON public.bots
  FOR UPDATE USING (true) WITH CHECK (true);

-- Indexes for lookups
CREATE INDEX IF NOT EXISTS idx_bots_email ON public.bots (email);
CREATE INDEX IF NOT EXISTS idx_bots_status ON public.bots (status);
CREATE INDEX IF NOT EXISTS idx_bots_last_seen ON public.bots (last_seen);
