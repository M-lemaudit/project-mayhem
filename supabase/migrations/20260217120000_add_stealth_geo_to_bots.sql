-- Geographical identity / stealth settings per bot (admin dashboard)
ALTER TABLE public.bots
  ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS locale TEXT DEFAULT 'en-US',
  ADD COLUMN IF NOT EXISTS latitude NUMERIC DEFAULT 25.7617,
  ADD COLUMN IF NOT EXISTS longitude NUMERIC DEFAULT -80.1918;

COMMENT ON COLUMN public.bots.timezone IS 'IANA timezone (e.g. Europe/Paris) for browser fingerprint';
COMMENT ON COLUMN public.bots.locale IS 'Locale (e.g. fr-FR) for browser fingerprint';
COMMENT ON COLUMN public.bots.latitude IS 'Latitude for geo (default Miami)';
COMMENT ON COLUMN public.bots.longitude IS 'Longitude for geo (default Miami)';
