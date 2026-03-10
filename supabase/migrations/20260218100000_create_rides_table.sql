-- Rides table: synced from Blacklane upcoming bookings per bot
CREATE TABLE IF NOT EXISTS public.rides (
  bot_id UUID NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  pickup TEXT NOT NULL DEFAULT '',
  dropoff TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, id)
);

CREATE INDEX IF NOT EXISTS idx_rides_bot_id ON public.rides (bot_id);
CREATE INDEX IF NOT EXISTS idx_rides_start_at ON public.rides (start_at);

ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rides_select_all" ON public.rides FOR SELECT USING (true);
CREATE POLICY "rides_insert_all" ON public.rides FOR INSERT WITH CHECK (true);
CREATE POLICY "rides_update_all" ON public.rides FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "rides_delete_all" ON public.rides FOR DELETE USING (true);

COMMENT ON TABLE public.rides IS 'Upcoming booked rides synced from Blacklane (getUpcomingBookings) per bot';
