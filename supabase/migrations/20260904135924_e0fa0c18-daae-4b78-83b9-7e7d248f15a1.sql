
CREATE TYPE public.locker_status AS ENUM ('AVAILABLE','RESERVED','IN_STORAGE','MAINTENANCE','BREAKDOWN');
CREATE TYPE public.reservation_status AS ENUM ('RESERVED','CHECKED_IN','STORED','PICKED_UP','CANCELLED');
CREATE TYPE public.incident_status AS ENUM ('OPEN','INVESTIGATING','RESOLVED');
CREATE TYPE public.incident_type AS ENUM ('TEMPERATURE','POWER','DOOR','SPOILAGE','OTHER');

CREATE TABLE public.farmers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  farm_name text NOT NULL,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.lockers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  locker_number text NOT NULL UNIQUE,
  zone text NOT NULL,
  temperature numeric(4,1) NOT NULL DEFAULT 2.0,
  capacity integer NOT NULL CHECK (capacity > 0),
  status public.locker_status NOT NULL DEFAULT 'AVAILABLE',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL REFERENCES public.farmers(id) ON DELETE CASCADE,
  locker_id uuid NOT NULL REFERENCES public.lockers(id) ON DELETE CASCADE,
  slot text NOT NULL,
  crate_count integer NOT NULL CHECK (crate_count > 0),
  status public.reservation_status NOT NULL DEFAULT 'RESERVED',
  reserved_at timestamptz NOT NULL DEFAULT now(),
  check_in_deadline timestamptz NOT NULL,
  checked_in_at timestamptz,
  pickup_code text NOT NULL DEFAULT upper(substr(md5(random()::text),1,6)),
  dropoff_code text NOT NULL DEFAULT upper(substr(md5(random()::text),1,6)),
  picked_up_at timestamptz,
  cancelled_at timestamptz
);
CREATE INDEX reservations_locker_idx ON public.reservations(locker_id);
CREATE INDEX reservations_farmer_idx ON public.reservations(farmer_id);

CREATE TABLE public.incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  locker_id uuid NOT NULL REFERENCES public.lockers(id) ON DELETE CASCADE,
  type public.incident_type NOT NULL,
  description text NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  status public.incident_status NOT NULL DEFAULT 'OPEN'
);
CREATE INDEX incidents_locker_idx ON public.incidents(locker_id);

-- crates currently committed to a locker (active reservation states only)
CREATE OR REPLACE FUNCTION public.locker_used_crates(_locker_id uuid, _exclude uuid DEFAULT NULL)
RETURNS integer LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(SUM(crate_count),0)::int
  FROM public.reservations
  WHERE locker_id = _locker_id
    AND status IN ('RESERVED','CHECKED_IN','STORED')
    AND (_exclude IS NULL OR id <> _exclude);
$$;

-- guard: capacity + locker availability
CREATE OR REPLACE FUNCTION public.enforce_reservation_rules()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  l public.lockers%ROWTYPE;
  used int;
BEGIN
  SELECT * INTO l FROM public.lockers WHERE id = NEW.locker_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Locker not found'; END IF;

  IF NEW.status IN ('RESERVED','CHECKED_IN','STORED') THEN
    IF l.status IN ('MAINTENANCE','BREAKDOWN') THEN
      RAISE EXCEPTION 'Locker % is % and cannot be reserved', l.locker_number, l.status;
    END IF;
    used := public.locker_used_crates(NEW.locker_id, NEW.id);
    IF used + NEW.crate_count > l.capacity THEN
      RAISE EXCEPTION 'Locker % has only % crate(s) free', l.locker_number, l.capacity - used;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reservations_enforce_rules
BEFORE INSERT OR UPDATE ON public.reservations
FOR EACH ROW EXECUTE FUNCTION public.enforce_reservation_rules();

-- keep locker status in sync with its active reservations
CREATE OR REPLACE FUNCTION public.sync_locker_status()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  _locker uuid := COALESCE(NEW.locker_id, OLD.locker_id);
  l public.lockers%ROWTYPE;
  stored_count int;
  active_count int;
BEGIN
  SELECT * INTO l FROM public.lockers WHERE id = _locker;
  IF l.status IN ('MAINTENANCE','BREAKDOWN') THEN RETURN NULL; END IF;

  SELECT count(*) FILTER (WHERE status IN ('CHECKED_IN','STORED')),
         count(*) FILTER (WHERE status IN ('RESERVED','CHECKED_IN','STORED'))
    INTO stored_count, active_count
  FROM public.reservations WHERE locker_id = _locker;

  UPDATE public.lockers
     SET status = CASE
       WHEN stored_count > 0 THEN 'IN_STORAGE'::public.locker_status
       WHEN active_count > 0 THEN 'RESERVED'::public.locker_status
       ELSE 'AVAILABLE'::public.locker_status END
   WHERE id = _locker;
  RETURN NULL;
END;
$$;

CREATE TRIGGER reservations_sync_locker
AFTER INSERT OR UPDATE OR DELETE ON public.reservations
FOR EACH ROW EXECUTE FUNCTION public.sync_locker_status();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.farmers TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lockers TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reservations TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.incidents TO anon, authenticated;
GRANT ALL ON public.farmers, public.lockers, public.reservations, public.incidents TO service_role;

ALTER TABLE public.farmers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lockers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "demo open access" ON public.farmers FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "demo open access" ON public.lockers FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "demo open access" ON public.reservations FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "demo open access" ON public.incidents FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- ---------- seed ----------
INSERT INTO public.farmers (id, name, farm_name, phone) VALUES
 ('11111111-1111-1111-1111-111111111101','Anita Rao','Hilltop Berry Farm','+91 98450 11223'),
 ('11111111-1111-1111-1111-111111111102','Joseph Mathew','Green Vale Strawberries','+91 98450 33445'),
 ('11111111-1111-1111-1111-111111111103','Priya Nair','Nair Blueberry Acres','+91 98450 55667'),
 ('11111111-1111-1111-1111-111111111104','Sunil Bhat','Bhat Raspberry Grove','+91 98450 77889'),
 ('11111111-1111-1111-1111-111111111105','Meera Kulkarni','Kulkarni Farmstead','+91 98450 99001');

INSERT INTO public.lockers (id, locker_number, zone, temperature, capacity, status) VALUES
 ('22222222-2222-2222-2222-222222222201','A-01','Zone A', 1.5, 24, 'AVAILABLE'),
 ('22222222-2222-2222-2222-222222222202','A-02','Zone A', 2.0, 24, 'AVAILABLE'),
 ('22222222-2222-2222-2222-222222222203','A-03','Zone A', 2.5, 18, 'AVAILABLE'),
 ('22222222-2222-2222-2222-222222222204','B-01','Zone B', 0.5, 36, 'AVAILABLE'),
 ('22222222-2222-2222-2222-222222222205','B-02','Zone B', 1.0, 36, 'AVAILABLE'),
 ('22222222-2222-2222-2222-222222222206','B-03','Zone B', 8.2, 36, 'AVAILABLE'),
 ('22222222-2222-2222-2222-222222222207','C-01','Zone C', 3.0, 12, 'AVAILABLE'),
 ('22222222-2222-2222-2222-222222222208','C-02','Zone C', 3.0, 12, 'AVAILABLE');

INSERT INTO public.reservations (farmer_id, locker_id, slot, crate_count, status, reserved_at, check_in_deadline, checked_in_at, picked_up_at) VALUES
 ('11111111-1111-1111-1111-111111111101','22222222-2222-2222-2222-222222222201','Morning 06:00-10:00', 10, 'STORED',      now() - interval '2 days', now() - interval '2 days' + interval '4 hours', now() - interval '2 days' + interval '2 hours', NULL),
 ('11111111-1111-1111-1111-111111111102','22222222-2222-2222-2222-222222222201','Midday 10:00-14:00',   8, 'RESERVED',    now() - interval '3 hours', now() + interval '3 hours', NULL, NULL),
 ('11111111-1111-1111-1111-111111111103','22222222-2222-2222-2222-222222222204','Morning 06:00-10:00', 20, 'CHECKED_IN',  now() - interval '6 hours', now() - interval '2 hours', now() - interval '4 hours', NULL),
 ('11111111-1111-1111-1111-111111111104','22222222-2222-2222-2222-222222222205','Evening 16:00-20:00', 12, 'RESERVED',    now() - interval '1 hour', now() + interval '5 hours', NULL, NULL),
 ('11111111-1111-1111-1111-111111111105','22222222-2222-2222-2222-222222222207','Midday 10:00-14:00',   6, 'STORED',      now() - interval '1 day', now() - interval '20 hours', now() - interval '22 hours', NULL),
 ('11111111-1111-1111-1111-111111111101','22222222-2222-2222-2222-222222222208','Morning 06:00-10:00',  5, 'PICKED_UP',   now() - interval '4 days', now() - interval '4 days' + interval '4 hours', now() - interval '4 days' + interval '1 hour', now() - interval '3 days'),
 ('11111111-1111-1111-1111-111111111102','22222222-2222-2222-2222-222222222202','Evening 16:00-20:00',  9, 'CANCELLED',   now() - interval '2 days', now() - interval '2 days' + interval '4 hours', NULL, NULL);

INSERT INTO public.incidents (locker_id, type, description, reported_at, status) VALUES
 ('22222222-2222-2222-2222-222222222206','TEMPERATURE','Unit holding at 8.2 C, well above the 2 C target. Compressor cycling.', now() - interval '5 hours','OPEN'),
 ('22222222-2222-2222-2222-222222222203','DOOR','Door seal torn, frost building on the inside edge.', now() - interval '1 day','INVESTIGATING'),
 ('22222222-2222-2222-2222-222222222205','POWER','Brief power dip during the storm, unit recovered on its own.', now() - interval '3 days','RESOLVED');

UPDATE public.lockers SET status = 'BREAKDOWN'  WHERE locker_number = 'B-03';
UPDATE public.lockers SET status = 'MAINTENANCE' WHERE locker_number = 'A-03';
