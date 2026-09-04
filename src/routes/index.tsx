import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AlertTriangle, History, LayoutGrid, Moon, PackageCheck, Sun, Sunrise, Sunset } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  boardQuery,
  freeCrates,
  isReservable,
  isOutOfService,
  slotSummary,
  agoLabel,
  moveReservation,
  usedCrates,

  LOCKER_LABEL,
  SLOT_LABEL,
  shortTime,
  checkInDeadline,
  clockTime,
  isCheckInUrgent,
  CHECK_IN_WINDOW_MINUTES,
  statusTone,
  tempState,
  TEMP_LABEL,
  availabilityLabel,

  expireOverdueReservations,
  tempTone,
  INCIDENT_OPTIONS,
  INCIDENT_LABEL,
  openIncidents,
  reportIncident,
  ACTIVE_RESERVATION_STATUSES,
  buildActivity,
  displayStatus,
  displayTone,
  formatCountdown,
  DISPLAY_STATUS_LABEL,
  type DisplayStatus,
  type IncidentType,
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
import { PhoneShell } from "@/components/PhoneShell";
import { useTheme } from "@/lib/theme";
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
/** Fired whenever the saved booking changes, so Home can pick it up instantly. */
const LAST_RESERVATION_EVENT = "coldstore:last-reservation-changed";

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
  const [liveFreeCrates, setLiveFreeCrates] = useState<number | null>(null);
  const [farmerId, setFarmerId] = useState(data.farmers[0]?.id ?? "");
  const [pickedSlot, setPickedSlot] = useState<HarvestSlot>(slot);
  // Capacity is per harvest slot, so the numbers follow the chosen slot.
  const free = liveFreeCrates ?? freeCrates(locker, data.reservations, pickedSlot);
  const [crates, setCrates] = useState(1);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<Reservation | null>(null);
  const [showBooking, setShowBooking] = useState(false);
  const [shortfall, setShortfall] = useState<number | null>(null);
  const tState = tempState(Number(locker.temperature));

  // Never let the crate count exceed what the chosen slot still has free.
  useEffect(() => {
    setCrates((c) => Math.max(1, Math.min(c, Math.max(1, free))));
  }, [free]);


  // The database is the authority on capacity: it re-checks under a row lock and
  // reports the real number of free crates as "CAPACITY:<n>".
  function capacityFromError(message?: string): number | null {
    const match = /CAPACITY:(\d+)/.exec(message ?? "");
    return match?.[1] ? Number(match[1]) : null;
  }

  async function reserve() {
    if (!farmerId || crates <= 0 || saving) return;
    setSaving(true);
    setShortfall(null);

    // Free any expired reservations first so capacity reflects reality.
    await expireOverdueReservations();
    const [{ data: freshLocker }, { data: freshRes }] = await Promise.all([
      supabase.from("lockers").select("*").eq("id", locker.id).maybeSingle(),
      supabase.from("reservations").select("*").eq("locker_id", locker.id),
    ]);

    const stillOpen =
      freshLocker && freshLocker.status !== "MAINTENANCE" && freshLocker.status !== "BREAKDOWN";
    const liveFree = freshLocker ? freeCrates(freshLocker, freshRes ?? [], pickedSlot) : 0;
    setLiveFreeCrates(liveFree);

    if (!stillOpen) {
      setSaving(false);
      await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
      toast.error(`${locker.locker_number} is no longer available.`);
      onClose();
      return;
    }

    if (crates > liveFree) {
      setSaving(false);
      setShortfall(liveFree);
      await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
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
      const left = capacityFromError(error?.message);
      if (left !== null) {
        // Lost a race with another farmer — the database refused the booking.
        setLiveFreeCrates(left);
        setShortfall(left);
        return;
      }
      toast.error(error?.message ?? "The reservation could not be made.");
      return;
    }

    try {
      localStorage.setItem(LAST_RESERVATION_KEY, created.id);
      window.dispatchEvent(new Event(LAST_RESERVATION_EVENT));
    } catch {
      /* storage unavailable — confirmation still shows now */
    }
    setDone(created);
    toast.success(
      `Reservation confirmed · ${locker.locker_number} · ${created.crate_count} crate${
        created.crate_count === 1 ? "" : "s"
      } — check in within ${CHECK_IN_WINDOW_MINUTES} minutes.`,
    );

    await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
  }

  if (shortfall !== null) {
    return (
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader>
          <SheetTitle className="text-xl font-semibold">Not enough capacity</SheetTitle>
          <SheetDescription>
            {shortfall === 0
              ? `${locker.locker_number} is full right now.`
              : `Only ${shortfall} crate${shortfall === 1 ? "" : "s"} ${shortfall === 1 ? "is" : "are"} available in ${locker.locker_number}.`}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-3 px-4 pb-6">
          <p className="rounded-lg bg-muted p-3 text-sm">
            Someone else took the space while you were booking. Nothing was saved.
          </p>
          {shortfall > 0 ? (
            <Button
              className="h-14 w-full text-base"
              onClick={() => {
                setCrates(Math.min(crates, shortfall));
                setShortfall(null);
              }}
            >
              Reserve {shortfall} crate{shortfall === 1 ? "" : "s"}
            </Button>
          ) : (
            <Button className="h-14 w-full text-base" onClick={onClose}>
              Back to board
            </Button>
          )}
        </div>
      </SheetContent>
    );
  }


  if (done) {
    if (showBooking) {
      return <ReservationSheet locker={locker} data={data} onClose={onClose} />;
    }
    return (
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader>
          <SheetTitle className="text-xl font-semibold">✓ Locker reserved</SheetTitle>
          <SheetDescription>
            {locker.locker_number} · {SLOT_LABEL[done.slot as HarvestSlot] ?? done.slot} ·{" "}
            {done.crate_count} crate{done.crate_count === 1 ? "" : "s"}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          <Countdown deadline={done.check_in_deadline} />
          <div className="grid grid-cols-2 gap-2">
            <div className="panel p-3">
              <p className="stat-label">Drop-off code</p>
              <p className="text-xl font-semibold tracking-[0.2em]">{done.dropoff_code}</p>
            </div>
            <div className="panel p-3">
              <p className="stat-label">Pickup code</p>
              <p className="text-xl font-semibold tracking-[0.2em]">{done.pickup_code}</p>
            </div>
          </div>
          <Button
            type="button"
            className="pressable h-[52px] w-full rounded-xl text-[15px] font-semibold"
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
        <SheetTitle className="text-xl font-semibold">{locker.locker_number}</SheetTitle>
        <SheetDescription>
          {free} of {locker.capacity} crates free in {SLOT_LABEL[pickedSlot].toLowerCase()} ·{" "}
          {Number(locker.temperature).toFixed(1)} °C · {tState}
        </SheetDescription>

      </SheetHeader>

      <div className="space-y-5 px-4 pb-6">
        <div>
          <p className="stat-label mb-2">Your farm</p>
          <div className="grid max-h-40 gap-2 overflow-y-auto pr-1">
            {data.farmers.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFarmerId(f.id)}
                className={`panel pressable min-h-12 rounded-xl px-4 text-left text-[15px] font-medium ${
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
                onClick={() => {
                  setPickedSlot(s);
                  setLiveFreeCrates(null);
                }}
                className={`panel pressable min-h-[52px] rounded-xl text-[13px] font-semibold leading-tight ${
                  pickedSlot === s ? "ring-2 ring-primary bg-primary text-primary-foreground" : ""
                }`}
              >
                <span className="block">{SLOT_LABEL[s]}</span>
                <span className="block text-[11px] font-medium opacity-80">
                  {freeCrates(locker, data.reservations, s)} crates free
                </span>
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
              className="pressable size-14 rounded-xl text-2xl"
              aria-label="One crate fewer"
              disabled={crates <= 1}
              onClick={() => setCrates((c) => Math.max(1, c - 1))}
            >
              −
            </Button>
            <span className="w-14 text-center text-3xl font-semibold tabular-nums">{crates}</span>
            <Button
              type="button"
              variant="outline"
              className="pressable size-14 rounded-xl text-2xl"
              aria-label="One crate more"
              disabled={crates >= free}
              onClick={() => setCrates((c) => Math.min(free, c + 1))}
            >
              +
            </Button>
            <span className="text-sm text-muted-foreground">
              {free} crate{free === 1 ? "" : "s"} available
            </span>
          </div>
        </div>

        <Button
          type="button"
          className="pressable h-[52px] w-full rounded-xl text-[15px] font-semibold"
          disabled={saving || !farmerId || crates <= 0 || crates > free}
          onClick={reserve}
        >
          {saving
            ? "Reserving…"
            : `Reserve ${crates} crate${crates === 1 ? "" : "s"}`}
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
  const [dropoff, setDropoff] = useState<Reservation | null>(null);
  const [pickup, setPickup] = useState<Reservation | null>(null);
  const active = data.reservations.filter(
    (r) => r.locker_id === locker.id && ["RESERVED", "CHECKED_IN", "STORED"].includes(r.status),
  );
  const storing = locker.status === "IN_STORAGE";

  if (dropoff) {
    return (
      <DropOffContent
        locker={locker}
        reservation={dropoff}
        data={data}
        onBack={() => setDropoff(null)}
        onClose={onClose}
      />
    );
  }

  if (pickup) {
    return (
      <PickupContent
        locker={locker}
        reservation={pickup}
        onBack={() => setPickup(null)}
        onClose={onClose}
      />
    );
  }

  return (
    <SheetContent side="bottom" className="rounded-t-2xl">
      <SheetHeader>
        <SheetTitle className="text-xl font-semibold">
          {locker.locker_number} · {storing ? "Storage" : "Booking"}
        </SheetTitle>
        <SheetDescription>{LOCKER_LABEL[locker.status]}</SheetDescription>
      </SheetHeader>
      <ul className="space-y-3 px-4 pb-6">
        {active.map((r) => {
          const farmer = data.farmers.find((f) => f.id === r.farmer_id);
          const expired =
            r.status === "RESERVED" && Date.now() > new Date(r.check_in_deadline).getTime();
          return (
            <li key={r.id} className="panel p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-base font-bold">{farmer?.farm_name ?? "Unknown farm"}</span>
                <Chip tone={displayTone(displayStatus(r))}>
                  {DISPLAY_STATUS_LABEL[displayStatus(r)]}
                </Chip>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                <dt className="stat-label">Crates</dt>
                <dd className="font-semibold">{r.crate_count}</dd>
                <dt className="stat-label">Slot</dt>
                <dd className="font-semibold">{SLOT_LABEL[r.slot as HarvestSlot] ?? r.slot}</dd>
                <dt className="stat-label">Reserved</dt>
                <dd className="font-semibold">{shortTime(r.reserved_at)}</dd>
                {r.status === "RESERVED" && (
                  <>
                    <dt className="stat-label">Check in by</dt>
                    <dd className="font-semibold">{shortTime(r.check_in_deadline)}</dd>
                    <dt className="stat-label">Drop-off code</dt>
                    <dd className="text-lg font-semibold tracking-[0.2em]">
                      {r.dropoff_code}
                    </dd>
                  </>
                )}
                {r.status !== "RESERVED" && (
                  <>
                    <dt className="stat-label">Pickup code</dt>
                    <dd className="text-lg font-semibold tracking-[0.2em]">
                      {r.pickup_code}
                    </dd>
                  </>
                )}
              </dl>
              {r.status === "RESERVED" &&
                (expired ? (
                  <div className="mt-3 space-y-2">
                    <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-sm font-semibold">
                      Reservation expired — {locker.locker_number} was released because the
                      crates were not checked in within {CHECK_IN_WINDOW_MINUTES} minutes.
                    </p>
                    <Button
                      type="button"
                      className="pressable h-12 w-full rounded-xl text-[15px] font-semibold"
                      onClick={onClose}
                    >
                      Book again
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    className="mt-3 pressable h-12 w-full rounded-xl text-[15px] font-semibold"
                    onClick={() => setDropoff(r)}
                  >
                    Confirm drop-off
                  </Button>
                ))}
              {r.status === "CHECKED_IN" && (
                <p className="mt-3 rounded-md border border-border bg-muted p-2.5 text-sm font-semibold">
                  Drop-off confirmed {shortTime(r.checked_in_at)} — no further check-in needed.
                </p>
              )}
              {(r.status === "CHECKED_IN" || r.status === "STORED") && (
                <Button
                  type="button"
                  className="mt-3 pressable h-12 w-full rounded-xl text-[15px] font-semibold"
                  onClick={() => setPickup(r)}
                >
                  Verify pickup
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </SheetContent>
  );
}

type DropOffStep = "code" | "confirm" | "success" | "expired" | "already";

function DropOffContent({
  locker,
  reservation,
  data,
  onBack,
  onClose,
}: {
  locker: Locker;
  reservation: Reservation;
  data: BoardData;
  onBack: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<DropOffStep>("code");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isExpired = Date.now() > new Date(reservation.check_in_deadline).getTime();
  const farmer = data.farmers.find((f) => f.id === reservation.farmer_id);

  async function confirm() {
    if (submitting) return; // double-tap protection
    setSubmitting(true);
    setError(null);
    try {
      // Expired: release the reservation, never check in.
      if (Date.now() > new Date(reservation.check_in_deadline).getTime()) {
        const { error: relErr } = await supabase
          .from("reservations")
          .update({ status: "CANCELLED", cancelled_at: new Date().toISOString() })
          .eq("id", reservation.id)
          .eq("status", "RESERVED");
        if (relErr) throw relErr;
        await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
        setStep("expired");
        return;
      }

      // Wrong code: no state change, allow retry.
      if (code.trim() !== reservation.dropoff_code) {
        setError("That code doesn't match. Check the code and try again.");
        setStep("code");
        return;
      }

      // Conditional update: only succeeds if still RESERVED (no duplicate check-in).
      const { data: updated, error: upErr } = await supabase
        .from("reservations")
        .update({ status: "CHECKED_IN", checked_in_at: new Date().toISOString() })
        .eq("id", reservation.id)
        .eq("status", "RESERVED")
        .select("*");
      if (upErr) throw upErr;

      await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
      if (updated && updated.length > 0) {
        setStep("success");
      } else {
        // No row updated: someone else changed it first. Find out what happened.
        const { data: current } = await supabase
          .from("reservations")
          .select("status")
          .eq("id", reservation.id)
          .maybeSingle();
        setStep(current?.status === "CANCELLED" ? "expired" : "already");
      }
    } catch (e) {
      // Network / server failure: no false success, allow retry.
      setError(
        e instanceof Error && e.message
          ? `Couldn't reach the storage service (${e.message}). Nothing was changed — tap Retry.`
          : "Couldn't reach the storage service. Nothing was changed — tap Retry.",
      );
      setStep("code");
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "success") {
    return (
      <SheetContent side="bottom" className="rounded-t-2xl">
        <div className="space-y-4 px-4 pt-2 pb-6 text-center">
          <p className="text-2xl font-semibold">✓ Drop-off confirmed</p>
          <div className="panel p-4">
            <p className="text-xl font-semibold">{locker.locker_number}</p>
            <p className="mt-1 text-lg font-semibold">
              {reservation.crate_count} crate{reservation.crate_count === 1 ? "" : "s"}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">Crates are now stored.</p>
          </div>
          <Button type="button" className="pressable h-[52px] w-full rounded-xl text-[15px] font-semibold" onClick={onClose}>
            Done
          </Button>
        </div>
      </SheetContent>
    );
  }

  if (step === "expired") {
    return (
      <SheetContent side="bottom" className="rounded-t-2xl">
        <div className="space-y-4 px-4 pt-2 pb-6 text-center">
          <p className="text-2xl font-semibold">Reservation expired</p>
          <p className="text-base text-muted-foreground">
            The check-in deadline ({shortTime(reservation.check_in_deadline)}) has passed. Locker{" "}
            {locker.locker_number} has been released and can be reserved again.
          </p>
          <Button type="button" className="pressable h-[52px] w-full rounded-xl text-[15px] font-semibold" onClick={onClose}>
            Done
          </Button>
        </div>
      </SheetContent>
    );
  }

  if (step === "already") {
    return (
      <SheetContent side="bottom" className="rounded-t-2xl">
        <div className="space-y-4 px-4 pt-2 pb-6 text-center">
          <p className="text-2xl font-semibold">Already checked in</p>
          <p className="text-base text-muted-foreground">
            This reservation was already confirmed — no new check-in was created.
          </p>
          <Button type="button" className="pressable h-[52px] w-full rounded-xl text-[15px] font-semibold" onClick={onClose}>
            Done
          </Button>
        </div>
      </SheetContent>
    );
  }

  return (
    <SheetContent side="bottom" className="rounded-t-2xl">
      <SheetHeader>
        <SheetTitle className="text-xl font-semibold">
          Drop-off · {locker.locker_number}
        </SheetTitle>
        <SheetDescription>
          {reservation.crate_count} crate{reservation.crate_count === 1 ? "" : "s"} ·{" "}
          {SLOT_LABEL[reservation.slot as HarvestSlot] ?? reservation.slot} slot ·{" "}
          {farmer?.farm_name ?? "Unknown farm"} · check in by{" "}
          {clockTime(reservation.check_in_deadline)}
        </SheetDescription>
      </SheetHeader>

      {isExpired ? (
        <div className="space-y-4 px-4 pb-6">
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm font-semibold">
            The check-in deadline has passed. This reservation can no longer be checked in and will
            be released.
          </p>
          <Button
            type="button"
            variant="destructive"
            className="pressable h-[52px] w-full rounded-xl text-[15px] font-semibold"
            disabled={submitting}
            onClick={confirm}
          >
            {submitting ? "Releasing…" : "Release reservation"}
          </Button>
          <Button type="button" variant="ghost" className="h-12 w-full rounded-xl" onClick={onBack}>
            Back
          </Button>
        </div>
      ) : (
        <div className="space-y-4 px-4 pb-6">
          <div>
            <label htmlFor="dropoff-code" className="stat-label mb-2 block">
              Enter the 4-digit drop-off code
            </label>
            <input
              id="dropoff-code"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
              className="panel w-full rounded-xl px-4 py-3 text-center text-3xl font-semibold tracking-[0.4em] tabular-nums"
              placeholder="····"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm font-semibold text-destructive">
              {error}
            </p>
          )}
          <Button
            type="button"
            className="pressable h-[52px] w-full rounded-xl text-[15px] font-semibold"
            disabled={submitting || code.length !== 4}
            onClick={confirm}
          >
            {submitting ? "Checking…" : error ? "Retry" : "Confirm"}
          </Button>
          <Button type="button" variant="ghost" className="h-12 w-full rounded-xl" onClick={onBack}>
            Back
          </Button>
        </div>
      )}
    </SheetContent>
  );
}

type PickupStep = "code" | "success" | "already";

function PickupContent({
  locker,
  reservation,
  onBack,
  onClose,
}: {
  locker: Locker;
  reservation: Reservation;
  onBack: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<PickupStep>("code");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (submitting) return; // double-tap protection
    setSubmitting(true);
    setError(null);
    try {
      // Wrong code: no state change, allow retry.
      if (code.trim() !== reservation.pickup_code) {
        setError("That code doesn't match. Check the code and try again.");
        return;
      }

      // Conditional update: only succeeds while the reservation is still in storage
      // (prevents duplicate pickup). Crate capacity is released by the same update.
      const { data: updated, error: upErr } = await supabase
        .from("reservations")
        .update({ status: "PICKED_UP", picked_up_at: new Date().toISOString() })
        .eq("id", reservation.id)
        .in("status", ["CHECKED_IN", "STORED"])
        .select("*");
      if (upErr) throw upErr;

      await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
      setStep(updated && updated.length > 0 ? "success" : "already");
    } catch (e) {
      // Network / server failure: no false success, allow retry.
      setError(
        e instanceof Error && e.message
          ? `Couldn't reach the storage service (${e.message}). Nothing was changed — tap Retry.`
          : "Couldn't reach the storage service. Nothing was changed — tap Retry.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "success") {
    return (
      <SheetContent side="bottom" className="rounded-t-2xl">
        <div className="space-y-4 px-4 pt-2 pb-6 text-center">
          <p className="text-2xl font-semibold">✓ Pickup verified</p>
          <div className="panel p-4">
            <p className="text-xl font-semibold">
              {locker.locker_number} released.
            </p>
            <p className="mt-1 text-lg font-semibold">
              {reservation.crate_count} crate{reservation.crate_count === 1 ? "" : "s"} removed from
              storage.
            </p>
          </div>
          <Button type="button" className="pressable h-[52px] w-full rounded-xl text-[15px] font-semibold" onClick={onClose}>
            Back to board
          </Button>
        </div>
      </SheetContent>
    );
  }

  if (step === "already") {
    return (
      <SheetContent side="bottom" className="rounded-t-2xl">
        <div className="space-y-4 px-4 pt-2 pb-6 text-center">
          <p className="text-2xl font-semibold">Already picked up</p>
          <p className="text-base text-muted-foreground">
            This reservation was already collected — no new pickup was recorded.
          </p>
          <Button type="button" className="pressable h-[52px] w-full rounded-xl text-[15px] font-semibold" onClick={onClose}>
            Done
          </Button>
        </div>
      </SheetContent>
    );
  }

  return (
    <SheetContent side="bottom" className="rounded-t-2xl">
      <SheetHeader>
        <SheetTitle className="text-xl font-semibold">
          {locker.locker_number} · Pickup
        </SheetTitle>
        <SheetDescription>
          {reservation.crate_count} crate{reservation.crate_count === 1 ? "" : "s"} ·{" "}
          {DISPLAY_STATUS_LABEL[displayStatus(reservation)]}
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-4 px-4 pb-6">
        <div>
          <label htmlFor="pickup-code" className="stat-label mb-2 block">
            Enter the 4-digit pickup code
          </label>
          <input
            id="pickup-code"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
            className="panel w-full rounded-xl px-4 py-3 text-center text-3xl font-semibold tracking-[0.4em] tabular-nums"
            placeholder="····"
          />
        </div>
        {error && (
          <p role="alert" className="text-sm font-semibold text-destructive">
            {error}
          </p>
        )}
        <Button
          type="button"
          className="pressable h-[52px] w-full rounded-xl text-[15px] font-semibold"
          disabled={submitting || code.length !== 4}
          onClick={confirm}
        >
          {submitting ? "Verifying…" : error ? "Retry" : "Verify pickup"}
        </Button>
        <Button type="button" variant="ghost" className="h-12 w-full rounded-xl" onClick={onBack}>
          Back
        </Button>
      </div>
    </SheetContent>
  );
}

function ReportIssueContent({
  data,
  lockerId,
  onClose,
}: {
  data: BoardData;
  lockerId?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [type, setType] = useState<IncidentType | null>(null);
  const [picked, setPicked] = useState(lockerId ?? data.lockers[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const locker = data.lockers.find((l) => l.id === picked);
  const option = INCIDENT_OPTIONS.find((o) => o.type === type);

  async function submit() {
    if (!type || !picked || saving) return;
    setSaving(true);
    try {
      await reportIncident({ lockerId: picked, type, description });
      await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
      setDone(locker?.locker_number ?? "");
    } catch (e) {
      toast.error(
        `Could not report the issue. ${e instanceof Error ? e.message : "Please try again."}`,
      );
    } finally {
      setSaving(false);
    }
  }

  if (done !== null) {
    return (
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader>
          <SheetTitle className="text-xl font-semibold">✓ Issue reported</SheetTitle>
          <SheetDescription>
            {option?.blocks
              ? `${done} has been marked out of service.`
              : `Thanks — the issue on ${done} has been logged.`}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-3 px-4 pb-6">
          <p className="rounded-md border border-border bg-muted p-3 text-sm">
            {option?.blocks
              ? "No new crates can be booked into this locker until it is fixed. Crates already stored there stay where they are."
              : "The locker stays available. The team will look into it."}
          </p>
          <Button type="button" className="pressable h-12 w-full rounded-xl text-[15px] font-semibold" onClick={onClose}>
            Done
          </Button>
        </div>
      </SheetContent>
    );
  }

  return (
    <SheetContent side="bottom" className="max-h-[92vh] overflow-y-auto rounded-t-2xl">
      <SheetHeader>
        <SheetTitle className="text-xl font-semibold">⚠ Report issue</SheetTitle>
        <SheetDescription>What happened?</SheetDescription>
      </SheetHeader>
      <div className="space-y-4 px-4 pb-6">
        <div className="grid gap-3" role="group" aria-label="What happened?">
          {INCIDENT_OPTIONS.map((o) => {
            const selected = type === o.type;
            return (
              <button
                key={o.type}
                type="button"
                aria-pressed={selected}
                onClick={() => setType(o.type)}
                className={`panel pressable min-h-12 rounded-xl px-3 text-left text-[15px] font-medium ${
                  selected ? `option-${o.tone}-selected` : `option-${o.tone}`
                }`}
              >
                <span className={selected ? "text-current" : ""}>{o.label}</span>
                {o.blocks && (
                  <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-current opacity-70" />
                )}
              </button>
            );
          })}
        </div>

        <div>
          <label className="stat-label mb-3 block" htmlFor="incident-locker">
            Locker
          </label>
          <select
            id="incident-locker"
            className="panel h-12 w-full rounded-xl px-3 text-base font-semibold"
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
          >
            {data.lockers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.locker_number} · {l.zone}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="stat-label mb-3 block" htmlFor="incident-note">
            Description (optional)
          </label>
          <textarea
            id="incident-note"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short note"
            className="panel w-full rounded-xl px-3 py-2 text-base"
          />
        </div>

        {type && (
          <p className="meta-text">
            {INCIDENT_OPTIONS.find((o) => o.type === type)?.blocks
              ? "This locker will be marked out of service straight away."
              : "The locker stays available — the issue is logged for the team."}
          </p>
        )}

        <div className="sticky bottom-0 -mx-4 border-t border-border bg-popover px-4 pt-3 pb-1">
          <Button
            type="button"
            disabled={!type || !picked || saving}
            className="pressable h-[52px] w-full rounded-xl text-[15px] font-semibold"
            onClick={submit}
          >
            {saving ? "Reporting…" : "Report issue"}
          </Button>
        </div>
      </div>
    </SheetContent>
  );
}


/** Shown instead of the booking form when the device has no connection. */
function OfflineNotice({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const [retrying, setRetrying] = useState(false);

  return (
    <SheetContent side="bottom" className="rounded-t-2xl">
      <SheetHeader>
        <SheetTitle className="text-xl font-semibold">You're offline</SheetTitle>
        <SheetDescription>
          Locker information is available from your last sync.
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-3 px-4 pb-6">
        <p className="rounded-lg bg-muted p-3 text-sm">
          New reservations require a connection to prevent double-booking.
        </p>
        <Button
          className="pressable h-[52px] w-full rounded-xl text-[15px] font-semibold"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
            setRetrying(false);
            if (online) {
              toast.success("Back online — locker information refreshed.");
              onClose();
            } else {
              toast.error("Still offline. Showing your last synced information.");
            }
          }}
        >
          {retrying ? "Checking…" : "Retry connection"}
        </Button>
      </div>
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
  // Capacity is tracked per harvest slot.
  const used = usedCrates(locker.id, data.reservations, slot);
  const storedAll = usedCrates(locker.id, data.reservations);
  const open = isReservable(locker, data.reservations, slot);
  const incidents = openIncidents(locker.id, data.incidents);
  const tState = tempState(Number(locker.temperature));
  const online = useOnline();
  const [sheet, setSheet] = useState<"reserve" | "view" | "report" | null>(null);


  const down = locker.status === "BREAKDOWN" || locker.status === "MAINTENANCE";


  const free = Math.max(0, locker.capacity - used);


  return (
    <article
      role={open ? "button" : undefined}
      tabIndex={open ? 0 : undefined}
      onClick={open ? () => setSheet("reserve") : undefined}
      onKeyDown={
        open
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setSheet("reserve");
              }
            }
          : undefined
      }
      className={`panel flex flex-col p-3.5 pl-4.5 ${statusTone(locker.status).replace("tone-", "edge-")} ${open ? "cursor-pointer" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="card-title truncate">{locker.locker_number}</h3>
          <p className="meta-text mt-0.5 truncate">{locker.zone}</p>
        </div>
        <Chip tone={statusTone(locker.status)}>
          {availabilityLabel(locker, data.reservations, slot)}
        </Chip>

      </div>

      {down ? (
        <div className="mt-2.5 text-sm">
          <p className="font-semibold">
            {incidents[0] ? INCIDENT_LABEL[incidents[0].type] : "Locker unavailable"}
          </p>
          {incidents[0]?.description && (
            <p className="meta-text mt-0.5">{incidents[0].description}</p>
          )}
          <p className="meta-text mt-0.5">
            New reservations blocked
            {used > 0
              ? ` · ${used} crate${used === 1 ? "" : "s"} still stored here — crates may need attention`
              : ""}
            .
          </p>
        </div>
      ) : (
        <>
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-medium">
              {Number(locker.temperature).toFixed(1)} °C
              <Chip tone={tempTone(tState)}>{TEMP_LABEL[tState]}</Chip>
            </span>
            <span className="text-sm font-semibold tabular-nums">
              {free}/{locker.capacity}
              <span className="text-muted-foreground">
                {" "}
                crates free · {SLOT_LABEL[slot].toLowerCase()}
              </span>
            </span>
          </div>
          <div className="mt-1.5">
            <CapacityBar used={used} capacity={locker.capacity} />
          </div>
          {storedAll > used && (
            <p className="meta-text mt-1">
              {storedAll - used} crate{storedAll - used === 1 ? "" : "s"} held here in the other slot
            </p>
          )}

        </>
      )}

      <div className="mt-3 grid gap-2" onClick={(e) => e.stopPropagation()}>
        {down ? (
          used > 0 ? (
            <Button
              variant="secondary"
              className="pressable h-12 w-full rounded-xl text-[15px] font-semibold"
              onClick={() => setSheet("view")}
            >
              View stored crates
            </Button>
          ) : null
        ) : (
          <>
            {open && (
              <Button
                className="pressable btn-gradient h-12 w-full rounded-xl text-[15px] font-semibold"
                onClick={() => setSheet("reserve")}
              >
                Reserve
              </Button>
            )}
            {!open && (
              <div className="panel-flat px-3 py-2.5 text-center shadow-none">
                <p className="text-sm font-semibold">No crates available</p>
                <p className="meta-text mt-0.5">
                  Try another locker or the{" "}
                  {SLOT_LABEL[slot === "MORNING" ? "AFTERNOON" : "MORNING"].toLowerCase()} slot.
                </p>
              </div>
            )}
          </>
        )}


        <div className={`grid gap-2 ${!down && used > 0 ? "grid-cols-2" : "grid-cols-1"}`}>
          {!down && used > 0 && (
            <Button
              variant="outline"
              className="pressable h-11 w-full rounded-xl text-sm font-semibold"
              onClick={() => setSheet("view")}
            >
              {locker.status === "IN_STORAGE" ? "View storage" : "View booking"}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            className="pressable h-11 w-full rounded-xl text-sm font-medium text-muted-foreground"
            onClick={() => setSheet("report")}
          >
            Report issue
          </Button>
        </div>
      </div>

      <Sheet open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
        {sheet === "reserve" ? (
          online ? (
            <ReserveSheet locker={locker} slot={slot} data={data} onClose={() => setSheet(null)} />
          ) : (
            <OfflineNotice onClose={() => setSheet(null)} />
          )
        ) : sheet === "view" ? (
          <ReservationSheet locker={locker} data={data} onClose={() => setSheet(null)} />
        ) : sheet === "report" ? (
          <ReportIssueContent
            data={data}
            lockerId={locker.id}
            onClose={() => setSheet(null)}
          />
        ) : null}
      </Sheet>

    </article>
  );
}


type Tab = "home" | "bookings" | "activity";

function Board() {
  const { slot } = Route.useSearch();
  const navigate = useNavigate({ from: "/" });
  const queryClient = useQueryClient();
  const { data, isPending, error, refetch, isFetching } = useQuery(boardQuery);
  const online = useOnline();
  const { theme, toggle } = useTheme();
  const [reporting, setReporting] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
  const [statusFilter, setStatusFilter] = useState<"AVAILABLE" | "RESERVED" | "IN_STORAGE" | "DOWN" | null>(null);
  const now = useNow();


  // When the connection comes back, pull authoritative locker/reservation state.
  useEffect(() => {
    async function onBackOnline() {
      toast.success("Back online · Syncing changes…");
      await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
      toast.success("Back online · Synced");

    }
    window.addEventListener("online", onBackOnline);
    return () => window.removeEventListener("online", onBackOnline);
  }, [queryClient]);

  const stale = !online || data?.fromCache === true;

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });


  return (
    <PhoneShell online={online}>
      <header className="header-hero shrink-0 border-b border-border px-4 pt-5 pb-4">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div className="min-w-0">
            <h1 className="screen-title flex items-center gap-1.5 truncate">
              <span aria-hidden="true">🍇</span> ColdStore
            </h1>
            <p className="meta-text truncate">Community berry storage · {today}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={toggle}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              className="pressable grid size-11 place-items-center rounded-full border border-border bg-secondary text-secondary-foreground"
            >
              {theme === "dark" ? <Sun className="size-5" /> : <Moon className="size-5" />}
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-6">
        {data && (
          stale ? (
            <div className="panel-flat mb-4 flex items-center justify-between gap-3 p-3">
              <p className="text-sm">
                <span className="flex items-center gap-2 font-semibold">
                  <span className="size-2.5 rounded-full tone-booked" aria-hidden="true" />
                  Offline · Changes saved locally
                </span>
                <span className="meta-text mt-0.5 block">
                  Showing saved information · last synced {agoLabel(data.syncedAt, now)}

                </span>

              </p>
              <Button
                type="button"
                variant="outline"
                className="pressable h-11 shrink-0 rounded-xl font-semibold"
                disabled={isFetching}
                onClick={() => refetch()}
              >
                {isFetching ? "Checking…" : "Retry"}
              </Button>
            </div>
          ) : (
            <p className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <span className="size-2 rounded-full tone-free" aria-hidden="true" />
              {isFetching ? "Syncing…" : `Live · synced ${agoLabel(data.syncedAt, now)}`}
            </p>

          )
        )}

        {isPending && <p className="mt-8 text-muted-foreground">Loading the board…</p>}
        {error && (
          <p className="mt-8 font-semibold text-destructive">
            The board couldn't load. Check your connection and pull to refresh.
          </p>
        )}

        {data && tab === "home" && (
          <>
            <LastReservationCard data={data} />

            <section className="mt-5 grid grid-cols-2 gap-3" aria-label="Locker summary">
              {(
                [
                  ["Available", "AVAILABLE", data.lockers.filter((l) => l.status === "AVAILABLE").length, "tone-free"],
                  ["Booked", "RESERVED", data.lockers.filter((l) => l.status === "RESERVED").length, "tone-booked"],
                  ["In storage", "IN_STORAGE", data.lockers.filter((l) => l.status === "IN_STORAGE").length, "tone-stored"],
                  [
                    "Out of service",
                    "DOWN",
                    data.lockers.filter(
                      (l) => l.status === "MAINTENANCE" || l.status === "BREAKDOWN",
                    ).length,
                    "tone-down",
                  ],
                ] as const
              ).map(([label, filter, value, tone]) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={statusFilter === filter}
                  onClick={() => setStatusFilter((f) => (f === filter ? null : filter))}
                  className={`pressable flex min-h-[56px] items-center gap-3 rounded-[var(--radius)] border p-3 text-left shadow-[var(--shadow-card)] ${tone.replace("tone-", "tile-")} ${
                    statusFilter === filter ? "ring-2 ring-primary" : ""
                  }`}
                >
                  <span className={`size-2.5 shrink-0 rounded-full ${tone}`} aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-xl leading-tight font-semibold tabular-nums">{value}</p>
                    <p className="meta-text truncate">{label}</p>
                  </div>
                </button>
              ))}
            </section>

            <section className="mt-5" aria-label="Harvest slot">
              <p className="stat-label mb-2">Harvest slot</p>
              <div className="grid grid-cols-2 gap-3" role="group">
                {(["MORNING", "AFTERNOON"] as const).map((s) => {
                  const Icon = s === "MORNING" ? Sunrise : Sunset;
                  const active = slot === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={active}
                      onClick={() => navigate({ search: { slot: s }, replace: true })}
                      className={`pressable flex min-h-[64px] items-center justify-center gap-2.5 rounded-xl border px-3 ${
                        active
                          ? "btn-gradient border-transparent shadow-sm"
                          : "panel text-foreground"
                      }`}
                    >
                      <Icon className="size-6 shrink-0" aria-hidden="true" />
                      <span className="text-left leading-tight">
                        <span className="block text-[15px] font-semibold">{SLOT_LABEL[s]}</span>
                        <span className={`block text-xs ${active ? "opacity-80" : "text-muted-foreground"}`}>
                          {s === "MORNING" ? "6 – 11 AM" : "12 – 5 PM"}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {(() => {
              const s = slotSummary(data, slot);
              return (
                <section
                  className="panel mt-5 flex items-center justify-between gap-3 p-3.5"
                  aria-label="Capacity for the selected slot"
                >
                  <div className="min-w-0">
                    <p className="stat-label">{SLOT_LABEL[slot]} capacity</p>
                    <p className="mt-0.5 text-lg leading-tight font-semibold tabular-nums">
                      {s.cratesFree} crates free
                    </p>
                    <p className="meta-text">
                      {s.lockersFree} locker{s.lockersFree === 1 ? "" : "s"} with room
                      {s.outOfService > 0 ? ` · ${s.outOfService} out of service` : ""}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
                      s.cratesFree > 0 ? "tone-free" : "tone-down"
                    }`}
                  >
                    {s.cratesFree > 0 ? "Space available" : "Full"}
                  </span>
                </section>
              );
            })()}

            <section className="mt-5 grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="section-heading">
                  {statusFilter === null
                    ? "Locker availability"
                    : statusFilter === "DOWN"
                      ? "Out of service"
                      : `${LOCKER_LABEL[statusFilter]} lockers`}
                </h2>
                {statusFilter !== null && (
                  <button
                    type="button"
                    onClick={() => setStatusFilter(null)}
                    className="meta-text pressable rounded-md px-2 py-1 font-semibold text-primary"
                  >
                    Show all
                  </button>
                )}
              </div>
              {data.lockers
                .filter((locker) =>
                  statusFilter === null
                    ? true
                    : statusFilter === "DOWN"
                      ? locker.status === "MAINTENANCE" || locker.status === "BREAKDOWN"
                      : locker.status === statusFilter,
                )
                .map((locker) => (
                  <LockerCard key={locker.id} locker={locker} data={data} slot={slot} />
                ))}
              <p className="meta-text mt-1 px-0.5">
                Fair allocation: first come, first served. Reservations that are not checked in
                within {CHECK_IN_WINDOW_MINUTES} minutes are released back to the community.
              </p>
            </section>

          </>
        )}

        {data && tab === "bookings" && <BookingsTab data={data} />}

        {data && tab === "activity" && <ActivityTab data={data} />}

      </div>

      <nav className="shrink-0 border-t border-border bg-card px-2 pt-1.5 pb-2">
        <ul className="grid grid-cols-4">
          {(
            [
              ["home", "Home", LayoutGrid],
              ["bookings", "Bookings", PackageCheck],
              ["activity", "Activity", History],
            ] as const
          ).map(([key, label, Icon]) => (
            <li key={key}>
              <button
                type="button"
                aria-current={tab === key ? "page" : undefined}
                onClick={() => setTab(key)}
                className={`pressable flex h-14 w-full flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-semibold ${
                  tab === key ? "bg-accent text-primary" : "text-muted-foreground"
                }`}
              >
                <Icon className="size-5" />
                {label}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => setReporting(true)}
              className="pressable flex h-14 w-full flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-semibold text-destructive"
            >
              <AlertTriangle className="size-5" />
              Report
            </button>
          </li>
        </ul>
      </nav>

      {data && (
        <Sheet open={reporting} onOpenChange={setReporting}>
          {reporting && <ReportIssueContent data={data} onClose={() => setReporting(false)} />}
        </Sheet>
      )}
    </PhoneShell>
  );
}


/** Re-render every second so countdowns stay live. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * One reservation, with the actions that are legal in its current state.
 * Used by the Bookings tab and by the active-reservation card on Home.
 */
function BookingCard({
  reservation,
  data,
  compact = false,
}: {
  reservation: Reservation;
  data: BoardData;
  compact?: boolean;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const [sheet, setSheet] = useState<"dropoff" | "pickup" | "move" | null>(null);
  const locker = data.lockers.find((l) => l.id === reservation.locker_id);
  const farmer = data.farmers.find((f) => f.id === reservation.farmer_id);
  const status = displayStatus(reservation, now);
  const remaining =
    reservation.status === "RESERVED" ? formatCountdown(reservation.check_in_deadline, now) : null;
  const urgent = reservation.status === "RESERVED" && isCheckInUrgent(reservation.check_in_deadline, now);
  const lockerDown = locker?.status === "BREAKDOWN" || locker?.status === "MAINTENANCE";
  const incidents = locker ? openIncidents(locker.id, data.incidents) : [];

  // Deadline just passed while the card was on screen: free the crates.
  useEffect(() => {
    if (reservation.status !== "RESERVED") return;
    if (Date.now() <= new Date(reservation.check_in_deadline).getTime()) return;
    void expireOverdueReservations().then(() =>
      queryClient.invalidateQueries({ queryKey: boardQuery.queryKey }),
    );
  }, [reservation.status, reservation.check_in_deadline, now, queryClient, reservation.id]);

  return (
    <article
      className={`panel min-w-0 overflow-hidden p-4 pl-5 ${displayTone(status).replace("tone-", "edge-")} ${
        compact ? "border-primary/60" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {compact && (
            <p className="stat-label">
              Your {(SLOT_LABEL[reservation.slot as HarvestSlot] ?? reservation.slot).toLowerCase()}{" "}
              reservation
            </p>
          )}
          <h3 className="card-title truncate">🫐 {locker?.locker_number ?? "—"}</h3>
          <p className="meta-text truncate">
            {reservation.crate_count} crate{reservation.crate_count === 1 ? "" : "s"} ·{" "}
            {SLOT_LABEL[reservation.slot as HarvestSlot] ?? reservation.slot}
            {farmer ? ` · ${farmer.farm_name}` : ""}
          </p>
        </div>
        <Chip tone={displayTone(status)}>{DISPLAY_STATUS_LABEL[status]}</Chip>
      </div>

      {reservation.status === "RESERVED" && remaining && (
        <>
          <p className="mt-2.5 text-sm font-medium">
            Check in within {CHECK_IN_WINDOW_MINUTES} minutes
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className={`panel-flat p-3 ${urgent ? "border-destructive/60" : ""}`}>
              <p className="stat-label">Check in by</p>
              <p className="text-xl font-semibold tabular-nums">
                {clockTime(reservation.check_in_deadline)}
              </p>
              <p
                className={`text-sm font-semibold tabular-nums ${
                  urgent ? "text-destructive" : "text-booked"
                }`}
              >
                {remaining} remaining
              </p>
            </div>
            <div className="panel-flat p-3">
              <p className="stat-label">Verification code</p>
              <p className="text-2xl font-semibold tracking-[0.2em] tabular-nums text-stored">
                {reservation.dropoff_code}
              </p>
            </div>
          </div>
        </>
      )}


      {(reservation.status === "CHECKED_IN" || reservation.status === "STORED") && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="panel-flat p-3">
            <p className="stat-label">Dropped off</p>
            <p className="text-base font-semibold">{shortTime(reservation.checked_in_at)}</p>
          </div>
          <div className="panel-flat p-3">
            <p className="stat-label">Pickup code</p>
            <p className="text-2xl font-semibold tracking-[0.2em] tabular-nums text-stored">
              {reservation.pickup_code}
            </p>
          </div>
        </div>
      )}

      {status === "COMPLETED" && (
        <p className="meta-text mt-2">
          Picked up {shortTime(reservation.picked_up_at)} · {reservation.crate_count} crate
          {reservation.crate_count === 1 ? "" : "s"} released.
        </p>
      )}
      {status === "EXPIRED" && (
        <p className="mt-2 text-sm">
          Not checked in within {CHECK_IN_WINDOW_MINUTES} minutes. {reservation.crate_count} crate
          {reservation.crate_count === 1 ? "" : "s"} released back to community storage.
        </p>
      )}
      {status === "CANCELLED" && (
        <p className="meta-text mt-2">Cancelled {shortTime(reservation.cancelled_at)}.</p>
      )}

      {lockerDown && ACTIVE_RESERVATION_STATUSES.includes(reservation.status) && (
        <div className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <p className="font-semibold">
            ⚠ Your locker is unavailable · {locker?.locker_number}
          </p>
          {incidents[0] && (
            <p className="mt-0.5">{INCIDENT_LABEL[incidents[0].type]} reported</p>
          )}
          {reservation.status === "RESERVED" ? (
            <>
              <p className="mt-0.5 text-muted-foreground">Your reservation needs to be moved.</p>
              <Button
                type="button"
                className="pressable mt-2.5 h-12 w-full rounded-xl text-[15px] font-semibold"
                onClick={() => setSheet("move")}
              >
                Move reservation
              </Button>
            </>
          ) : (
            <p className="mt-0.5 text-muted-foreground">
              Your crates are safe and this booking is kept. Staff have been alerted.
            </p>
          )}
        </div>
      )}

      {locker && reservation.status === "RESERVED" && remaining && !lockerDown && (
        <Button
          type="button"
          className="pressable mt-3 h-14 w-full rounded-xl bg-free text-base font-semibold text-free-foreground hover:bg-free/90"
          onClick={() => setSheet("dropoff")}
        >
          Check in / Drop off
        </Button>
      )}

      {locker && (reservation.status === "CHECKED_IN" || reservation.status === "STORED") && (
        <Button
          type="button"
          className="pressable mt-3 h-14 w-full rounded-xl text-base font-semibold"
          onClick={() => setSheet("pickup")}
        >
          Pick up crates
        </Button>
      )}

      {locker && (
        <Sheet open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
          {sheet === "dropoff" ? (
            <DropOffContent
              locker={locker}
              reservation={reservation}
              data={data}
              onBack={() => setSheet(null)}
              onClose={() => setSheet(null)}
            />
          ) : sheet === "pickup" ? (
            <PickupContent
              locker={locker}
              reservation={reservation}
              onBack={() => setSheet(null)}
              onClose={() => setSheet(null)}
            />
          ) : sheet === "move" ? (
            <MoveContent
              locker={locker}
              reservation={reservation}
              data={data}
              onClose={() => setSheet(null)}
            />
          ) : null}

        </Sheet>
      )}
    </article>
  );
}

/** The farmer's own most recent reservation, shown at the top of Home. */
function LastReservationCard({ data }: { data: BoardData }) {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    function read() {
      try {
        setId(localStorage.getItem(LAST_RESERVATION_KEY));
      } catch {
        setId(null);
      }
    }
    read();
    window.addEventListener(LAST_RESERVATION_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(LAST_RESERVATION_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);

  // Prefer the booking made on this device; otherwise surface the newest live
  // booking so the board always answers "what do I do next?".
  const saved = id ? data.reservations.find((r) => r.id === id) : undefined;
  const reservation =
    saved ??
    [...data.reservations]
      .filter((r) => ACTIVE_RESERVATION_STATUSES.includes(r.status))
      .sort((a, b) => new Date(b.reserved_at).getTime() - new Date(a.reserved_at).getTime())[0];
  if (!reservation) return null;
  if (reservation.status === "PICKED_UP") return null;

  const locker = data.lockers.find((l) => l.id === reservation.locker_id);

  // Expired before check-in: the lazy expiration released the crates.
  if (reservation.status === "CANCELLED" && !reservation.checked_in_at) {
    return (
      <section className="panel border-destructive/50 p-4" aria-label="Reservation expired">
        <p className="stat-label">Reservation expired</p>
        <p className="card-title mt-0.5">{locker?.locker_number ?? "—"}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {reservation.crate_count} crate{reservation.crate_count === 1 ? "" : "s"} released back to
          community storage because they were not checked in within {CHECK_IN_WINDOW_MINUTES}{" "}
          minutes.
        </p>
        <Button
          type="button"
          className="pressable mt-3 h-12 w-full rounded-xl text-[15px] font-semibold"
          onClick={() => {
            try {
              localStorage.removeItem(LAST_RESERVATION_KEY);
              window.dispatchEvent(new Event(LAST_RESERVATION_EVENT));
            } catch {
              /* ignore */
            }
            setId(null);
          }}
        >
          Book again
        </Button>
      </section>
    );
  }

  return <BookingCard reservation={reservation} data={data} compact />;
}



const BOOKING_GROUPS: { key: DisplayStatus[]; title: string }[] = [
  { key: ["CHECK_IN_REQUIRED", "RESERVED"], title: "Awaiting drop-off" },
  { key: ["IN_STORAGE"], title: "In storage" },
  { key: ["COMPLETED"], title: "Completed" },
  { key: ["EXPIRED", "CANCELLED"], title: "Expired & cancelled" },
];

function BookingsTab({ data }: { data: BoardData }) {
  const now = useNow(5000);
  const sorted = [...data.reservations].sort(
    (a, b) => new Date(b.reserved_at).getTime() - new Date(a.reserved_at).getTime(),
  );

  return (
    <>
      <h2 className="section-heading">Your bookings</h2>
      {sorted.length === 0 && (
        <p className="panel-flat mt-3 p-4 text-sm text-muted-foreground">
          No bookings yet. Reserve a locker from Home.
        </p>
      )}
      {BOOKING_GROUPS.map((group) => {
        const items = sorted.filter((r) => group.key.includes(displayStatus(r, now)));
        if (items.length === 0) return null;
        return (
          <section key={group.title} className="mt-4">
            <p className="stat-label mb-2">
              {group.title} · {items.length}
            </p>
            <div className="grid gap-3">
              {items.map((r) => (
                <BookingCard key={r.id} reservation={r} data={data} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

function ActivityTab({ data }: { data: BoardData }) {
  const events = buildActivity(data).slice(0, 40);
  return (
    <>
      <h2 className="section-heading">Recent activity</h2>
      {events.length === 0 && (
        <p className="panel-flat mt-3 p-4 text-sm text-muted-foreground">Nothing has happened yet.</p>
      )}
      <ul className="mt-3 grid gap-2">
        {events.map((e) => (
          <li key={e.id} className={`panel p-3.5 pl-4 ${e.tone.replace("tone-", "edge-")}`}>
            <div className="flex items-start justify-between gap-3">
              <p className="text-[15px] font-semibold">{e.title}</p>
              <span className="meta-text shrink-0 tabular-nums">{shortTime(e.at)}</span>
            </div>
            <p className="meta-text mt-0.5">{e.detail}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Live "check in within 45 minutes" panel used on the confirmation screen. */
function Countdown({ deadline }: { deadline: string }) {
  const now = useNow();
  const remaining = formatCountdown(deadline, now);
  return (
    <div className="panel p-4">
      <p className="stat-label">Check-in deadline</p>
      <p className="text-3xl font-semibold tabular-nums">{remaining ?? "00:00"}</p>
      <p className="mt-1 text-sm font-medium">remaining · check in by {clockTime(deadline)}</p>
      <p className="mt-2 text-sm text-muted-foreground">
        If you do not check in within {CHECK_IN_WINDOW_MINUTES} minutes, this reservation is released
        back to community storage.
      </p>
    </div>
  );
}

/**
 * Emergency re-booking: a still-RESERVED booking whose locker went out of
 * service can be moved to another locker with room in the same harvest slot.
 * The booking is never silently deleted.
 */
function MoveContent({
  locker,
  reservation,
  data,
  onClose,
}: {
  locker: Locker;
  reservation: Reservation;
  data: BoardData;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState<string | null>(null);
  const slot = reservation.slot as HarvestSlot;

  const options = data.lockers
    .filter(
      (l) =>
        l.id !== locker.id &&
        !isOutOfService(l) &&
        freeCrates(l, data.reservations, slot) >= reservation.crate_count,
    )
    .sort(
      (a, b) =>
        freeCrates(b, data.reservations, slot) - freeCrates(a, data.reservations, slot),
    );

  async function move(targetId: string, label: string) {
    if (saving) return;
    setSaving(targetId);
    try {
      await moveReservation(reservation, targetId);
      await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
      toast.success(`Reservation moved to ${label}. Your code stays the same.`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The booking could not be moved.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <SheetContent side="bottom" className="rounded-t-2xl">
      <SheetHeader>
        <SheetTitle className="text-xl font-semibold">Move reservation</SheetTitle>
        <SheetDescription>
          {locker.locker_number} is out of service. Pick another locker with room for{" "}
          {reservation.crate_count} crate{reservation.crate_count === 1 ? "" : "s"} in the{" "}
          {(SLOT_LABEL[slot] ?? slot).toLowerCase()} slot.
        </SheetDescription>
      </SheetHeader>

      <div className="grid gap-3 px-4 pb-6">
        {options.length === 0 ? (
          <p className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm font-semibold">
            No suitable storage is currently available. Your booking is kept — try again shortly or
            report it to the shed keeper.
          </p>
        ) : (
          options.map((l) => {
            const free = freeCrates(l, data.reservations, slot);
            const t = tempState(Number(l.temperature));
            return (
              <div key={l.id} className="panel-flat p-3">
                <p className="text-sm font-semibold">
                  {l.locker_number} · {free} crate{free === 1 ? "" : "s"} available
                </p>
                <p className="meta-text mt-0.5">
                  {l.zone} · {Number(l.temperature).toFixed(1)} °C · {t}
                </p>
                <Button
                  type="button"
                  disabled={saving !== null}
                  className="pressable mt-2 h-12 w-full rounded-xl text-[15px] font-semibold"
                  onClick={() => void move(l.id, l.locker_number)}
                >
                  {saving === l.id ? "Moving…" : "Move here"}
                </Button>
              </div>
            );
          })
        )}
        <Button
          type="button"
          variant="secondary"
          className="pressable h-12 w-full rounded-xl text-[15px] font-semibold"
          onClick={onClose}
        >
          Keep it here for now
        </Button>
      </div>
    </SheetContent>
  );
}
