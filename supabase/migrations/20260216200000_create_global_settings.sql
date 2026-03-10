-- Global settings (one row, shared by all bots). Delay between requests = random between min and max.
CREATE TABLE IF NOT EXISTS public.global_settings (
  id INT PRIMARY KEY DEFAULT 1,
  sniper_delay_min_ms INT NOT NULL DEFAULT 1000,
  sniper_delay_max_ms INT NOT NULL DEFAULT 3000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_settings_single_row CHECK (id = 1)
);

INSERT INTO public.global_settings (id, sniper_delay_min_ms, sniper_delay_max_ms)
VALUES (1, 1000, 3000)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.global_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "global_settings_select" ON public.global_settings FOR SELECT USING (true);
CREATE POLICY "global_settings_update" ON public.global_settings FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "global_settings_insert" ON public.global_settings FOR INSERT WITH CHECK (true);
