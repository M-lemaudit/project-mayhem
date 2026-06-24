-- Security hardening: lock down tables that were exposed to the anon key.
--
-- Threat fixed: `accepted_offers` (and now its billing columns) and `global_settings` had
-- `USING (true)` policies for the `public` role, so anyone with the anon key could read EVERY
-- user's rides/prices/addresses and even modify them. `rides` had RLS disabled entirely.
--
-- Model (mirrors the already-correct `bots` table): the backend bot uses the service-role key
-- and does all writes; logged-in users may only READ rows belonging to bots they own; anon gets
-- nothing. Admin reads already filter by the user's own bots, so RLS only enforces what the UI
-- already assumed.

-- ── accepted_offers ────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "accepted_offers_select_all" ON public.accepted_offers;
DROP POLICY IF EXISTS "accepted_offers_insert_all" ON public.accepted_offers;
DROP POLICY IF EXISTS "accepted_offers_update_all" ON public.accepted_offers;

DROP POLICY IF EXISTS "accepted_offers_service_role_all" ON public.accepted_offers;
CREATE POLICY "accepted_offers_service_role_all" ON public.accepted_offers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "accepted_offers_select_own" ON public.accepted_offers;
CREATE POLICY "accepted_offers_select_own" ON public.accepted_offers
  FOR SELECT TO authenticated
  USING (bot_id IN (SELECT id FROM public.bots WHERE user_id = auth.uid()));

-- ── rides (RLS was disabled — fully exposed) ────────────────────────────────────────────────
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rides_service_role_all" ON public.rides;
CREATE POLICY "rides_service_role_all" ON public.rides
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "rides_select_own" ON public.rides;
CREATE POLICY "rides_select_own" ON public.rides
  FOR SELECT TO authenticated
  USING (bot_id IN (SELECT id FROM public.bots WHERE user_id = auth.uid()));

-- ── global_settings (non-sensitive: keep public read, restrict writes to the backend) ───────
DROP POLICY IF EXISTS "global_settings_insert" ON public.global_settings;
DROP POLICY IF EXISTS "global_settings_update" ON public.global_settings;

DROP POLICY IF EXISTS "global_settings_service_role_all" ON public.global_settings;
CREATE POLICY "global_settings_service_role_all" ON public.global_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
-- existing `global_settings_select` (public, USING true) intentionally kept: polling delays are not secret.
