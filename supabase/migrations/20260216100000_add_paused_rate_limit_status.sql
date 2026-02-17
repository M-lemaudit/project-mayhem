-- Add PAUSED_RATE_LIMIT to bots.status for 429 handling
ALTER TABLE public.bots DROP CONSTRAINT IF EXISTS bots_status_check;
ALTER TABLE public.bots ADD CONSTRAINT bots_status_check
  CHECK (status IN ('RUNNING', 'STOPPED', 'ERROR_AUTH', 'PAUSED_RATE_LIMIT'));
