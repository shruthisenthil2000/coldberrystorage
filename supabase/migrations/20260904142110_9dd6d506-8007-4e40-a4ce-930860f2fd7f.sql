CREATE OR REPLACE FUNCTION public.enforce_reservation_rules()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  l public.lockers%ROWTYPE;
  used int;
  ok boolean;
BEGIN
  -- Validate state transitions on update
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    ok := (OLD.status, NEW.status) IN (
      ('RESERVED','CHECKED_IN'),
      ('RESERVED','CANCELLED'),
      ('CHECKED_IN','STORED'),
      ('CHECKED_IN','PICKED_UP'),
      ('STORED','PICKED_UP')
    );
    IF NOT ok THEN
      RAISE EXCEPTION 'Invalid reservation transition % -> %', OLD.status, NEW.status;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('PICKED_UP','CANCELLED')
       AND (NEW.status IS DISTINCT FROM OLD.status
            OR NEW.crate_count IS DISTINCT FROM OLD.crate_count
            OR NEW.locker_id IS DISTINCT FROM OLD.locker_id) THEN
      RAISE EXCEPTION 'Reservation is already % and cannot be changed', OLD.status;
    END IF;
    IF OLD.status <> 'RESERVED'
       AND (NEW.locker_id IS DISTINCT FROM OLD.locker_id
            OR NEW.crate_count IS DISTINCT FROM OLD.crate_count) THEN
      RAISE EXCEPTION 'Locker and crate count cannot change after check-in';
    END IF;
  END IF;

  IF NEW.crate_count IS NULL OR NEW.crate_count <= 0 THEN
    RAISE EXCEPTION 'Crate count must be at least 1';
  END IF;

  IF NEW.status IN ('RESERVED','CHECKED_IN','STORED') THEN
    -- Row lock serialises concurrent bookings for the same locker
    SELECT * INTO l FROM public.lockers WHERE id = NEW.locker_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Locker not found'; END IF;

    IF l.status IN ('MAINTENANCE','BREAKDOWN')
       AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('RESERVED','CHECKED_IN','STORED')) THEN
      RAISE EXCEPTION 'Locker % is % and cannot be reserved', l.locker_number, l.status;
    END IF;

    used := public.locker_used_crates(NEW.locker_id, NEW.id);
    IF used + NEW.crate_count > l.capacity THEN
      RAISE EXCEPTION 'CAPACITY:%', GREATEST(l.capacity - used, 0);
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;