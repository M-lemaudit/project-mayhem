-- Billing reconciliation: mark which bot-booked offers were actually completed on Blacklane.
-- Source of truth = GET /hades/finished_rides (status finished|no_show). A reconciler matches
-- each finished ride back to an accepted_offer by id (offer_id = finished_rides.id) and stamps
-- these fields, recording the ride's actual final price.
-- "Billable" = an accepted_offer whose finished_ride_uuid is set; the 3% fee is computed at
-- read time from finished_price (BILLING_FEE_RATE in code), so a rate change needs no backfill.

ALTER TABLE public.accepted_offers
  ADD COLUMN IF NOT EXISTS completed_status   TEXT,        -- 'finished' | 'no_show'
  ADD COLUMN IF NOT EXISTS finished_ride_uuid TEXT,        -- finished_rides.id (idempotency key)
  ADD COLUMN IF NOT EXISTS booking_number     TEXT,
  ADD COLUMN IF NOT EXISTS finished_price      NUMERIC,    -- authoritative billing base (Blacklane final price)
  ADD COLUMN IF NOT EXISTS finished_currency   TEXT,
  ADD COLUMN IF NOT EXISTS completed_at        TIMESTAMPTZ, -- finished ride starts_at
  ADD COLUMN IF NOT EXISTS reconciled_at       TIMESTAMPTZ;

-- A given finished ride maps to at most one accepted_offer -> re-running the reconciler is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accepted_offers_finished_uuid
  ON public.accepted_offers (finished_ride_uuid)
  WHERE finished_ride_uuid IS NOT NULL;

-- Speeds up the billing page's "completed only" filter and monthly grouping.
CREATE INDEX IF NOT EXISTS idx_accepted_offers_completed_at
  ON public.accepted_offers (completed_at)
  WHERE completed_at IS NOT NULL;

-- The reconciler updates rows; mirror the table's existing permissive policy style.
DROP POLICY IF EXISTS "accepted_offers_update_all" ON public.accepted_offers;
CREATE POLICY "accepted_offers_update_all" ON public.accepted_offers FOR UPDATE USING (true) WITH CHECK (true);

COMMENT ON COLUMN public.accepted_offers.completed_status IS 'finished|no_show once reconciled against /hades/finished_rides; NULL = not yet completed/matched';
COMMENT ON COLUMN public.accepted_offers.finished_price IS 'Authoritative Blacklane final price; billing base for the 3% fee';
