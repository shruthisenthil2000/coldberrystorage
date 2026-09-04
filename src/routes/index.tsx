import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  boardQuery,
  freeCrates,
  isReservable,
  usedCrates,
  LOCKER_LABEL,
  RESERVATION_LABEL,
  SLOT_LABEL,
  reservationTone,
  shortTime,
  checkInDeadline,
  clockTime,
  CHECK_IN_WINDOW_MINUTES,
  statusTone,
  tempState,
  tempTone,
  type BoardData,
  type HarvestSlot,
  type Locker,
  type Reservation,
} from "@/lib/board";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useSyncExternalStore } from "react";

export const Route = createFileRoute("/")({
  validateSearch: (search): { slot: HarvestSlot } => ({
    slot: search["slot"] === "AFTERNOON" ? "AFTERNOON" : "MORNING",
  }),
  head: () => ({
    meta: [
      { title: "ColdStore — Shared Berry Cold Storage Board" },
      {
        name: "description",
        content:
          "Live board of shared cold-storage lockers for berry farmers: see which lockers can take your berries right now, crate space, temperatures and codes.",
      },
      { property: "og:title", content: "ColdStore — Shared Berry Cold Storage Board" },
      {
        property: "og:description",
        content:
          "Live board of shared cold-storage lockers for berry farmers: see which lockers can take your berries right now, crate space, temperatures and codes.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Board,
  errorComponent: ({ error }) => (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 pt-10">
      <p role="alert" className="font-semibold text-destructive">
        The board couldn't load. {error.message}
      </p>
    </main>
  ),
});

function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`status-chip ${tone}`}>{children}</span>;
}

function CapacityBar({ used, capacity }: { used: number; capacity: number }) {
  const pct = Math.min(100, Math.round((used / capacity) * 100));
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={pct >= 100 ? "h-full tone-down" : "h-full tone-stored"}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

const LAST_RESERVATION_KEY = "coldstore:last-reservation";

function ReserveSheet({
  locker,
  slot,
  data,
  onClose,
}: {
  locker: Locker;
  slot: HarvestSlot;
  data: BoardData;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const free = freeCrates(locker, data.reservations);
  const [farmerId, setFarmerId] = useState(data.farmers[0]?.id ?? "");
  const [pickedSlot, setPickedSlot] = useState<HarvestSlot>(slot);
  const [crates, setCrates] = useState(Math.min(1, free));
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<Reservation | null>(null);
  const [showBooking, setShowBooking] = useState(false);
  const tState = tempState(Number(locker.temperature));

  async function reserve() {
    if (!farmerId || crates <= 0 || crates > free) return;
    setSaving(true);

    // Re-check live capacity: someone else may have taken the space meanwhile.
    const [{ data: freshLocker }, { data: freshRes }] = await Promise.all([
      supabase.from("lockers").select("*").eq("id", locker.id).maybeSingle(),
      supabase.from("reservations").select("*").eq("locker_id", locker.id),
    ]);

    const stillOpen =
      freshLocker && freshLocker.status !== "MAINTENANCE" && freshLocker.status !== "BREAKDOWN";
    const liveFree = freshLocker ? freeCrates(freshLocker, freshRes ?? []) : 0;

    if (!stillOpen || crates > liveFree) {
      setSaving(false);
      await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
      toast.error(
        !stillOpen
          ? `Locker ${locker.locker_number} is no longer available.`
          : `Locker ${locker.locker_number} only has ${liveFree} crate${liveFree === 1 ? "" : "s"} left. Capacity refreshed.`,
      );
      onClose();
      return;
    }

    const { data: created, error } = await supabase
      .from("reservations")
      .insert({
        farmer_id: farmerId,
        locker_id: locker.id,
        slot: pickedSlot,
        crate_count: crates,
        check_in_deadline: checkInDeadline(),
      })
      .select("*")
      .single();

    setSaving(false);
    if (error || !created) {
      await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
      toast.error(error?.message ?? "The reservation could not be made.");
      return;
    }

    try {
      localStorage.setItem(LAST_RESERVATION_KEY, created.id);
    } catch {
      /* storage unavailable — confirmation still shows now */
    }
    setDone(created);
    await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
  }

  if (done) {
    if (showBooking) {
      return <ReservationSheet locker={locker} data={data} onClose={onClose} />;
    }
    return (
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader>
          <SheetTitle className="font-display text-2xl">✓ Locker reserved</SheetTitle>
          <SheetDescription>
            Locker {locker.locker_number} · {SLOT_LABEL[done.slot as HarvestSlot] ?? done.slot} ·{" "}
            {done.crate_count} crate{done.crate_count === 1 ? "" : "s"}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          <div className="panel p-4">
            <p className="stat-label">Check in by</p>
            <p className="font-display text-4xl font-bold">{clockTime(done.check_in_deadline)}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              If you do not check in within {CHECK_IN_WINDOW_MINUTES} minutes, this reservation will
              automatically be released.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="panel p-3">
              <p className="stat-label">Drop-off code</p>
              <p className="font-display text-2xl font-bold tracking-widest">{done.dropoff_code}</p>
            </div>
            <div className="panel p-3">
              <p className="stat-label">Pickup code</p>
              <p className="font-display text-2xl font-bold tracking-widest">{done.pickup_code}</p>
            </div>
          </div>
          <Button
            type="button"
            className="min-h-14 w-full text-lg font-bold"
            onClick={() => setShowBooking(true)}
          >
            View reservation
          </Button>
        </div>
      </SheetContent>
    );
  }

  return (
    <SheetContent side="bottom" className="rounded-t-2xl">
      <SheetHeader>
        <SheetTitle className="font-display text-2xl">Locker {locker.locker_number}</SheetTitle>
        <SheetDescription>
          {free} / {locker.capacity} crates available · {Number(locker.temperature).toFixed(1)} °C ·{" "}
          {tState}
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-5 px-4 pb-6">
        <div>
          <p className="stat-label mb-2">Your farm</p>
          <div className="grid gap-2">
            {data.farmers.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFarmerId(f.id)}
                className={`panel min-h-12 px-4 text-left text-base font-semibold ${
                  farmerId === f.id ? "ring-2 ring-primary" : ""
                }`}
              >
                {f.farm_name}
                <span className="ml-2 font-normal text-muted-foreground">{f.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="stat-label mb-2">Harvest slot</p>
          <div className="grid grid-cols-2 gap-2" role="group">
            {(["MORNING", "AFTERNOON"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={pickedSlot === s}
                onClick={() => setPickedSlot(s)}
                className={`panel min-h-14 text-lg font-bold ${
                  pickedSlot === s ? "ring-2 ring-primary bg-primary text-primary-foreground" : ""
                }`}
              >
                {SLOT_LABEL[s]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="stat-label mb-2">Crates</p>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              className="h-14 w-14 text-3xl"
              aria-label="One crate fewer"
              disabled={crates <= 1}
              onClick={() => setCrates((c) => Math.max(1, c - 1))}
            >
              −
            </Button>
            <span className="font-display w-12 text-center text-4xl font-bold">{crates}</span>
            <Button
              type="button"
              variant="outline"
              className="h-14 w-14 text-3xl"
              aria-label="One crate more"
              disabled={crates >= free}
              onClick={() => setCrates((c) => Math.min(free, c + 1))}
            >
              +
            </Button>
            <span className="text-sm text-muted-foreground">of {free} free</span>
          </div>
        </div>

        <Button
          type="button"
          className="min-h-14 w-full text-lg font-bold"
          disabled={saving || !farmerId || crates <= 0 || crates > free}
          onClick={reserve}
        >
          {saving ? "Reserving…" : "Reserve locker"}
        </Button>
      </div>
    </SheetContent>
  );
}


function ReservationSheet({
  locker,
  data,
  onClose,
}: {
  locker: Locker;
  data: BoardData;
  onClose: () => void;
}) {
  const active = data.reservations.filter(
    (r) => r.locker_id === locker.id && ["RESERVED", "CHECKED_IN", "STORED"].includes(r.status),
  );
  const storing = locker.status === "IN_STORAGE";

  return (
    <SheetContent side="bottom" className="rounded-t-2xl">
      <SheetHeader>
        <SheetTitle className="font-display text-2xl">
          Locker {locker.locker_number} · {storing ? "Storage" : "Booking"}
        </SheetTitle>
        <SheetDescription>{LOCKER_LABEL[locker.status]}</SheetDescription>
      </SheetHeader>
      <ul className="space-y-3 px-4 pb-6">
        {active.map((r) => {
          const farmer = data.farmers.find((f) => f.id === r.farmer_id);
          return (
            <li key={r.id} className="panel p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-base font-bold">{farmer?.farm_name ?? "Unknown farm"}</span>
                <Chip tone={reservationTone(r.status)}>{RESERVATION_LABEL[r.status]}</Chip>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {r.crate_count} crates · {SLOT_LABEL[r.slot as HarvestSlot] ?? r.slot} slot
              </p>
              {r.status === "RESERVED" ? (
                <p className="mt-2 text-base font-semibold">
                  Drop-off code <span className="font-display text-xl tracking-widest">{r.dropoff_code}</span>
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    by {shortTime(r.check_in_deadline)}
                  </span>
                </p>
              ) : (
                <p className="mt-2 text-base font-semibold">
                  Pickup code <span className="font-display text-xl tracking-widest">{r.pickup_code}</span>
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </SheetContent>
  );
}

function LockerCard({
  locker,
  data,
  slot,
}: {
  locker: Locker;
  data: BoardData;
  slot: HarvestSlot;
}) {
  const used = usedCrates(locker.id, data.reservations);
  const open = isReservable(locker, data.reservations);
  const incidents = data.incidents.filter(
    (i) => i.locker_id === locker.id && i.status !== "RESOLVED",
  );
  const tState = tempState(Number(locker.temperature));
  const [sheet, setSheet] = useState<"reserve" | "view" | null>(null);

  const down = locker.status === "BREAKDOWN" || locker.status === "MAINTENANCE";

  return (
    <article className="panel flex flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-3xl leading-none font-bold tracking-tight">
            {locker.locker_number}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{locker.zone}</p>
        </div>
        <Chip tone={statusTone(locker.status)}>{LOCKER_LABEL[locker.status]}</Chip>
      </div>

      <div className="mt-4 flex items-baseline justify-between">
        <span className="stat-label">Crates</span>
        <span className="font-display text-2xl font-bold">
          {used}
          <span className="text-muted-foreground">/{locker.capacity}</span>
        </span>
      </div>
      <div className="mt-1.5">
        <CapacityBar used={used} capacity={locker.capacity} />
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
        <span className="stat-label">Temp</span>
        <span className="flex items-center gap-2">
          <span className="font-bold">{Number(locker.temperature).toFixed(1)} °C</span>
          <Chip tone={tempTone(tState)}>{tState}</Chip>
        </span>
      </div>

      {incidents.length > 0 && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
          {incidents.map((i) => (
            <p key={i.id}>
              <span className="font-bold">{i.type}</span> — {i.description}
            </p>
          ))}
        </div>
      )}

      <div className="mt-4 flex-1" />

      {down ? (
        <p className="panel tone-muted min-h-12 rounded-md text-center text-sm leading-12 font-bold uppercase">
          Not available
        </p>
      ) : locker.status === "AVAILABLE" && open ? (
        <Button className="min-h-12 w-full text-base font-bold" onClick={() => setSheet("reserve")}>
          Reserve
        </Button>
      ) : (
        <Button
          variant="secondary"
          className="min-h-12 w-full text-base font-bold"
          onClick={() => setSheet("view")}
        >
          {locker.status === "IN_STORAGE" ? "View storage" : "View reservation"}
        </Button>
      )}

      <Sheet open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
        {sheet === "reserve" ? (
          <ReserveSheet locker={locker} slot={slot} data={data} onClose={() => setSheet(null)} />
        ) : sheet === "view" ? (
          <ReservationSheet locker={locker} data={data} onClose={() => setSheet(null)} />
        ) : null}
      </Sheet>
    </article>
  );
}

function Board() {
  const { slot } = Route.useSearch();
  const navigate = useNavigate({ from: "/" });
  const { data, isPending, error } = useQuery(boardQuery);
  const online = useOnline();

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 pt-5 pb-16">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="stat-label">ColdStore · Community Cold Storage</p>
          <h1 className="font-display text-4xl leading-none font-bold tracking-tight">
            Locker Board
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{today}</p>
        </div>
        <span
          className={`status-chip ${online ? "tone-free" : "tone-down"}`}
          role="status"
        >
          {online ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
          {online ? "Online" : "Offline"}
        </span>
      </header>

      {isPending && <p className="mt-8 text-muted-foreground">Loading the board…</p>}
      {error && (
        <p className="mt-8 font-semibold text-destructive">
          The board couldn't load. Check your connection and pull to refresh.
        </p>
      )}

      {data && (
        <>
          <LastReservationCard data={data} />

          <section className="mt-5 grid grid-cols-5 gap-1.5 max-sm:grid-cols-3">
            {(
              [
                ["Total", data.lockers.length, ""],
                ["Available", data.lockers.filter((l) => l.status === "AVAILABLE").length, "tone-free"],
                ["Booked", data.lockers.filter((l) => l.status === "RESERVED").length, "tone-booked"],
                ["In storage", data.lockers.filter((l) => l.status === "IN_STORAGE").length, "tone-stored"],
                [
                  "Down",
                  data.lockers.filter(
                    (l) => l.status === "MAINTENANCE" || l.status === "BREAKDOWN",
                  ).length,
                  "tone-down",
                ],
              ] as const
            ).map(([label, value, tone]) => (
              <div key={label} className={`panel p-2.5 ${tone ? "" : ""}`}>
                <p className="stat-label">{label}</p>
                <p className={`font-display text-3xl font-bold ${tone ? "" : ""}`}>{value}</p>
                {tone && <span className={`mt-1 block h-1 rounded-full ${tone}`} />}
              </div>
            ))}
          </section>

          <section className="mt-5" aria-label="Harvest slot">
            <p className="stat-label mb-2">Harvest slot</p>
            <div className="grid grid-cols-2 gap-2" role="group">
              {(["MORNING", "AFTERNOON"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={slot === s}
                  onClick={() => navigate({ search: { slot: s }, replace: true })}
                  className={`panel min-h-14 text-lg font-bold ${
                    slot === s ? "ring-2 ring-primary bg-primary text-primary-foreground" : ""
                  }`}
                >
                  {SLOT_LABEL[s]}
                </button>
              ))}
            </div>
          </section>

          <section className="mt-5 grid gap-3 sm:grid-cols-2">
            {data.lockers.map((locker) => (
              <LockerCard key={locker.id} locker={locker} data={data} slot={slot} />
            ))}
          </section>

          <section className="mt-8">
            <h2 className="font-display text-2xl font-bold tracking-tight">Recent bookings</h2>
            <ul className="mt-3 space-y-2">
              {data.reservations.slice(0, 8).map((r: Reservation) => {
                const farmer = data.farmers.find((f) => f.id === r.farmer_id);
                const locker = data.lockers.find((l) => l.id === r.locker_id);
                return (
                  <li key={r.id} className="panel flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">
                        {locker?.locker_number} · {farmer?.name}
                      </p>
                      <p className="truncate text-sm text-muted-foreground">
                        {r.crate_count} crates · {shortTime(r.reserved_at)}
                      </p>
                    </div>
                    <Chip tone={reservationTone(r.status)}>{RESERVATION_LABEL[r.status]}</Chip>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}

function LastReservationCard({ data }: { data: BoardData }) {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    try {
      setId(localStorage.getItem(LAST_RESERVATION_KEY));
    } catch {
      setId(null);
    }
  }, []);

  const reservation = id ? data.reservations.find((r) => r.id === id) : undefined;
  if (!reservation || reservation.status !== "RESERVED") return null;
  const locker = data.lockers.find((l) => l.id === reservation.locker_id);

  return (
    <section className="panel mt-5 border-2 border-primary p-4" aria-label="Your reservation">
      <p className="stat-label">✓ Locker reserved</p>
      <p className="font-display text-2xl font-bold">
        Locker {locker?.locker_number ?? "—"} ·{" "}
        {SLOT_LABEL[reservation.slot as HarvestSlot] ?? reservation.slot} ·{" "}
        {reservation.crate_count} crate{reservation.crate_count === 1 ? "" : "s"}
      </p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <p className="stat-label">Check in by</p>
          <p className="font-display text-3xl font-bold">
            {clockTime(reservation.check_in_deadline)}
          </p>
        </div>
        <div className="text-right">
          <p className="stat-label">Drop-off code</p>
          <p className="font-display text-2xl font-bold tracking-widest">
            {reservation.dropoff_code}
          </p>
        </div>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        If you do not check in within {CHECK_IN_WINDOW_MINUTES} minutes, this reservation will
        automatically be released.
      </p>
    </section>
  );
}
