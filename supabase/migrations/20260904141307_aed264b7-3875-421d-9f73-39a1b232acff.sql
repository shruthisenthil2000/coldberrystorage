ALTER TABLE public.reservations
  ALTER COLUMN pickup_code SET DEFAULT lpad(floor(random() * 10000)::int::text, 4, '0');