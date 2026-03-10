-- Add missing columns to rides (table may have been created with a minimal schema)
ALTER TABLE public.rides ADD COLUMN IF NOT EXISTS pickup TEXT NOT NULL DEFAULT '';
ALTER TABLE public.rides ADD COLUMN IF NOT EXISTS dropoff TEXT NOT NULL DEFAULT '';
ALTER TABLE public.rides ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
