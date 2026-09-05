ALTER TYPE public.incident_type ADD VALUE IF NOT EXISTS 'MECHANISM';

DO $$
DECLARE
  _locker uuid;
BEGIN
  -- Demo scenario: a locker that already holds crates suffers a cooling failure.
  SELECT r.locker_id INTO _locker
  FROM public.reservations r
  JOIN public.lockers l ON l.id = r.locker_id
  WHERE r.status IN ('CHECKED_IN','STORED')
    AND l.status NOT IN ('MAINTENANCE','BREAKDOWN')
  ORDER BY r.reserved_at DESC
  LIMIT 1;

  IF _locker IS NOT NULL THEN
    UPDATE public.lockers SET status = 'BREAKDOWN', temperature = 7.4 WHERE id = _locker;
    INSERT INTO public.incidents (locker_id, type, description, status, reported_at)
    VALUES (_locker, 'POWER', 'Cooling unit stopped — crates inside need staff attention', 'OPEN', now() - interval '12 minutes');
  END IF;
END $$;