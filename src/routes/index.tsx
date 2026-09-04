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
  expireOverdueReservations,
  tempTone,
  INCIDENT_OPTIONS,
  INCIDENT_LABEL,
  openIncidents,
  reportIncident,
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

    // Free any expired reservations first so capacity reflects reality,
    // then re-check live capacity: someone else may have taken the space meanwhile.
    await expireOverdueReservations();
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
        <SheetTitle className="font-display text-2xl">
          Locker {locker.locker_number} · {storing ? "Storage" : "Booking"}
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
                <Chip tone={reservationTone(r.status)}>{RESERVATION_LABEL[r.status]}</Chip>
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
                    <dd className="font-display text-lg font-bold tracking-widest">
                      {r.dropoff_code}
                    </dd>
                  </>
                )}
                {r.status !== "RESERVED" && (
                  <>
                    <dt className="stat-label">Pickup code</dt>
                    <dd className="font-display text-lg font-bold tracking-widest">
                      {r.pickup_code}
                    </dd>
                  </>
                )}
              </dl>
              {r.status === "RESERVED" &&
                (expired ? (
                  <div className="mt-3 space-y-2">
                    <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-sm font-semibold">
                      Reservation expired — locker {locker.locker_number} was released because the
                      crates were not checked in within {CHECK_IN_WINDOW_MINUTES} minutes.
                    </p>
                    <Button
                      type="button"
                      className="min-h-12 w-full text-base font-bold"
                      onClick={onClose}
                    >
                      Book again
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    className="mt-3 min-h-12 w-full text-base font-bold"
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
                  className="mt-3 min-h-12 w-full text-base font-bold"
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
          <p className="font-display text-3xl font-bold tracking-tight">✓ Drop-off confirmed</p>
          <div className="panel p-4">
            <p className="font-display text-2xl font-bold">Locker {locker.locker_number}</p>
            <p className="mt-1 text-lg font-semibold">
              {reservation.crate_count} crate{reservation.crate_count === 1 ? "" : "s"}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">Crates are now stored.</p>
          </div>
          <Button type="button" className="min-h-14 w-full text-lg font-bold" onClick={onClose}>
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
          <p className="font-display text-3xl font-bold tracking-tight">Reservation expired</p>
          <p className="text-base text-muted-foreground">
            The check-in deadline ({shortTime(reservation.check_in_deadline)}) has passed. Locker{" "}
            {locker.locker_number} has been released and can be reserved again.
          </p>
          <Button type="button" className="min-h-14 w-full text-lg font-bold" onClick={onClose}>
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
          <p className="font-display text-3xl font-bold tracking-tight">Already checked in</p>
          <p className="text-base text-muted-foreground">
            This reservation was already confirmed — no new check-in was created.
          </p>
          <Button type="button" className="min-h-14 w-full text-lg font-bold" onClick={onClose}>
            Done
          </Button>
        </div>
      </SheetContent>
    );
  }

  return (
    <SheetContent side="bottom" className="rounded-t-2xl">
      <SheetHeader>
        <SheetTitle className="font-display text-2xl">
          Drop-off · Locker {locker.locker_number}
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
            className="min-h-14 w-full text-lg font-bold"
            disabled={submitting}
            onClick={confirm}
          >
            {submitting ? "Releasing…" : "Release reservation"}
          </Button>
          <Button type="button" variant="ghost" className="min-h-12 w-full" onClick={onBack}>
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
              className="panel font-display w-full px-4 py-3 text-center text-4xl font-bold tracking-[0.5em]"
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
            className="min-h-14 w-full text-lg font-bold"
            disabled={submitting || code.length !== 4}
            onClick={confirm}
          >
            {submitting ? "Checking…" : error ? "Retry" : "Confirm"}
          </Button>
          <Button type="button" variant="ghost" className="min-h-12 w-full" onClick={onBack}>
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
          <p className="font-display text-3xl font-bold tracking-tight">✓ Pickup verified</p>
          <div className="panel p-4">
            <p className="font-display text-2xl font-bold">
              Locker {locker.locker_number} released.
            </p>
            <p className="mt-1 text-lg font-semibold">
              {reservation.crate_count} crate{reservation.crate_count === 1 ? "" : "s"} removed from
              storage.
            </p>
          </div>
          <Button type="button" className="min-h-14 w-full text-lg font-bold" onClick={onClose}>
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
          <p className="font-display text-3xl font-bold tracking-tight">Already picked up</p>
          <p className="text-base text-muted-foreground">
            This reservation was already collected — no new pickup was recorded.
          </p>
          <Button type="button" className="min-h-14 w-full text-lg font-bold" onClick={onClose}>
            Done
          </Button>
        </div>
      </SheetContent>
    );
  }

  return (
    <SheetContent side="bottom" className="rounded-t-2xl">
      <SheetHeader>
        <SheetTitle className="font-display text-2xl">
          Locker {locker.locker_number} · Pickup
        </SheetTitle>
        <SheetDescription>
          {reservation.crate_count} crate{reservation.crate_count === 1 ? "" : "s"} ·{" "}
          {RESERVATION_LABEL[reservation.status]}
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
            className="panel font-display w-full px-4 py-3 text-center text-4xl font-bold tracking-[0.5em]"
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
          className="min-h-14 w-full text-lg font-bold"
          disabled={submitting || code.length !== 4}
          onClick={confirm}
        >
          {submitting ? "Verifying…" : error ? "Retry" : "Verify pickup"}
        </Button>
        <Button type="button" variant="ghost" className="min-h-12 w-full" onClick={onBack}>
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
          <SheetTitle className="font-display text-2xl">✓ Issue reported</SheetTitle>
          <SheetDescription>Locker {done} has been flagged.</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 px-4 pb-6">
          {option?.blocks && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm font-semibold">
              Locker {done} will not accept new reservations until the problem is fixed. Crates
              already stored there stay where they are.
            </p>
          )}
          <Button type="button" className="min-h-12 w-full text-base font-bold" onClick={onClose}>
            Done
          </Button>
        </div>
      </SheetContent>
    );
  }

  return (
    <SheetContent side="bottom" className="max-h-[92vh] overflow-y-auto rounded-t-2xl">
      <SheetHeader>
        <SheetTitle className="font-display text-2xl">⚠ Report issue</SheetTitle>
        <SheetDescription>What happened?</SheetDescription>
      </SheetHeader>
      <div className="space-y-4 px-4 pb-6">
        <div className="grid gap-2" role="group" aria-label="What happened?">
          {INCIDENT_OPTIONS.map((o) => (
            <button
              key={o.type}
              type="button"
              aria-pressed={type === o.type}
              onClick={() => setType(o.type)}
              className={`panel min-h-12 px-3 text-left text-base font-bold ${
                type === o.type ? "bg-primary text-primary-foreground ring-2 ring-primary" : ""
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        <div>
          <label className="stat-label" htmlFor="incident-locker">
            Locker
          </label>
          <select
            id="incident-locker"
            className="panel mt-1 min-h-12 w-full px-3 text-base font-semibold"
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
          <label className="stat-label" htmlFor="incident-note">
            Description (optional)
          </label>
          <textarea
            id="incident-note"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short note"
            className="panel mt-1 w-full px-3 py-2 text-base"
          />
        </div>

        <Button
          type="button"
          disabled={!type || !picked || saving}
          className="min-h-14 w-full text-base font-bold"
          onClick={submit}
        >
          {saving ? "Reporting…" : "Report issue"}
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
  const used = usedCrates(locker.id, data.reservations);
  const open = isReservable(locker, data.reservations);
  const incidents = openIncidents(locker.id, data.incidents);
  const tState = tempState(Number(locker.temperature));
  const [sheet, setSheet] = useState<"reserve" | "view" | "report" | null>(null);

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
              <span className="font-bold">⚠ {INCIDENT_LABEL[i.type]}</span> — {i.description}
            </p>
          ))}
          {down && used > 0 && (
            <p className="mt-2 font-semibold">
              {used} crate{used === 1 ? "" : "s"} currently stored. The locker is unavailable for
              new reservations.
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex-1" />

      {down && used > 0 ? (
        <Button
          variant="secondary"
          className="min-h-12 w-full text-base font-bold"
          onClick={() => setSheet("view")}
        >
          View reservation
        </Button>
      ) : down ? (
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

      <Button
        type="button"
        variant="ghost"
        className="mt-2 min-h-11 w-full text-sm font-bold"
        onClick={() => setSheet("report")}
      >
        ⚠ Report issue
      </Button>

      <Sheet open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
        {sheet === "reserve" ? (
          <ReserveSheet locker={locker} slot={slot} data={data} onClose={() => setSheet(null)} />
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

          <Button
            type="button"
            variant="destructive"
            className="mt-5 min-h-14 w-full text-base font-bold"
            onClick={() => setReporting(true)}
          >
            ⚠ Report issue
          </Button>
          <Sheet open={reporting} onOpenChange={setReporting}>
            {reporting && (
              <ReportIssueContent data={data} onClose={() => setReporting(false)} />
            )}
          </Sheet>


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
  if (!reservation) return null;
  const locker = data.lockers.find((l) => l.id === reservation.locker_id);

  // Expired before check-in: the lazy expiration released the crates.
  if (
    reservation.status === "CANCELLED" &&
    !reservation.checked_in_at &&
    Date.now() > new Date(reservation.check_in_deadline).getTime()
  ) {
    return (
      <section
        className="panel mt-5 border-2 border-destructive/50 p-4"
        aria-label="Reservation expired"
      >
        <p className="stat-label">Reservation expired</p>
        <p className="font-display text-2xl font-bold">Locker {locker?.locker_number ?? "—"}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Locker {locker?.locker_number ?? "—"} was released because the crates were not checked in
          within {CHECK_IN_WINDOW_MINUTES} minutes.
        </p>
        <Button
          type="button"
          className="mt-3 min-h-12 w-full text-base font-bold"
          onClick={() => {
            try {
              localStorage.removeItem(LAST_RESERVATION_KEY);
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

  if (reservation.status !== "RESERVED") return null;

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
