ALTER TABLE public.reservations
  ALTER COLUMN dropoff_code SET DEFAULT lpad(floor(random() * 10000)::int::text, 4, '0');