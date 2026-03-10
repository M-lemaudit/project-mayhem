-- Add SLEEPING status for working-hours (bot idle outside configured hours)
ALTER TABLE public.bots DROP CONSTRAINT IF EXISTS bots_status_check;
ALTER TABLE public.bots ADD CONSTRAINT bots_status_check
  CHECK (status IN ('RUNNING', 'STOPPED', 'ERROR_AUTH', 'PAUSED_RATE_LIMIT', 'SLEEPING'));
