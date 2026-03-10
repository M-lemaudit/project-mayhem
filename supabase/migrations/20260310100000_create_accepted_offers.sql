-- Log of offers accepted by the bot (one row per accepted offer)
CREATE TABLE IF NOT EXISTS public.accepted_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
  offer_id TEXT NOT NULL,
  price TEXT,
  pickup_at TIMESTAMPTZ,
  pickup_address TEXT,
  dropoff_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accepted_offers_bot_offer ON public.accepted_offers (bot_id, offer_id);
CREATE INDEX IF NOT EXISTS idx_accepted_offers_bot_id ON public.accepted_offers (bot_id);
CREATE INDEX IF NOT EXISTS idx_accepted_offers_created_at ON public.accepted_offers (created_at DESC);

ALTER TABLE public.accepted_offers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "accepted_offers_select_all" ON public.accepted_offers FOR SELECT USING (true);
CREATE POLICY "accepted_offers_insert_all" ON public.accepted_offers FOR INSERT WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.accepted_offers;

COMMENT ON TABLE public.accepted_offers IS 'Log of offers accepted by the sniper bot (dashboard Live Snipe Log)';
