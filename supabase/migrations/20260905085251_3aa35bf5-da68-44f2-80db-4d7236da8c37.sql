GRANT SELECT, INSERT, UPDATE ON public.reservations TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.incidents TO anon, authenticated;
GRANT SELECT, UPDATE ON public.lockers TO anon, authenticated;
GRANT ALL ON public.reservations TO service_role;
GRANT ALL ON public.incidents TO service_role;
GRANT ALL ON public.lockers TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='lockers' AND cmd='UPDATE') THEN
    CREATE POLICY "anyone can update locker operational status"
      ON public.lockers FOR UPDATE TO anon, authenticated
      USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='incidents' AND cmd='UPDATE') THEN
    CREATE POLICY "anyone can resolve an incident"
      ON public.incidents FOR UPDATE TO anon, authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;