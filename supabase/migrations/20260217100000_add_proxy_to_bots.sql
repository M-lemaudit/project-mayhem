-- Add optional proxy URL for bot (e.g. http://user:pass@host:port)
ALTER TABLE public.bots
  ADD COLUMN IF NOT EXISTS proxy TEXT;

COMMENT ON COLUMN public.bots.proxy IS 'Optional proxy URL for browser and API (e.g. http://user:pass@host:port)';
