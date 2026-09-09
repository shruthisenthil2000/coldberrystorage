ALTER TABLE public.lockers
  ADD COLUMN IF NOT EXISTS location text NOT NULL DEFAULT 'Community Cold Hub, Village Road',
  ADD COLUMN IF NOT EXISTS price_per_crate numeric NOT NULL DEFAULT 20;

UPDATE public.lockers SET location = CASE
    WHEN zone ILIKE '%North%' THEN 'North Yard, Gate 1, Community Cold Hub, Kotagiri Road'
    WHEN zone ILIKE '%South%' THEN 'South Yard, Gate 3, Community Cold Hub, Kotagiri Road'
    ELSE 'Main Shed, Gate 2, Community Cold Hub, Kotagiri Road'
  END,
  price_per_crate = CASE
    WHEN capacity >= 30 THEN 25
    WHEN capacity >= 20 THEN 20
    ELSE 15
  END;