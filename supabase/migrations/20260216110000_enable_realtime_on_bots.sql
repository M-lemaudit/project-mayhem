-- Enable Realtime for bots table (Kill Switch, live status)
ALTER PUBLICATION supabase_realtime ADD TABLE public.bots;
