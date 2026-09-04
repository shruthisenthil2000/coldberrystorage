import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type Locker = Database["public"]["Tables"]["lockers"]["Row"];
export type Farmer = Database["public"]["Tables"]["farmers"]["Row"];
export type Reservation = Database["public"]["Tables"]["reservations"]["Row"];
export type Incident = Database["public"]["Tables"]["incidents"]["Row"];

export type LockerStatus = Locker["status"];
export type ReservationStatus = Reservation["status"];

export const ACTIVE_RESERVATION_STATUSES: ReservationStatus[] = [
  "RESERVED",
  "CHECKED_IN",
  "STORED",
];

export type BoardData = {
  lockers: Locker[];
  farmers: Farmer[];
  reservations: Reservation[];
  incidents: Incident[];
};

export async function fetchBoard(): Promise<BoardData> {
  const [lockers, farmers, reservations, incidents] = await Promise.all([
    supabase.from("lockers").select("*").order("locker_number"),
    supabase.from("farmers").select("*").order("name"),
    supabase.from("reservations").select("*").order("reserved_at", { ascending: false }),
    supabase.from("incidents").select("*").order("reported_at", { ascending: false }),
  ]);

  const error = lockers.error || farmers.error || reservations.error || incidents.error;
  if (error) throw error;

  return {
    lockers: lockers.data ?? [],
    farmers: farmers.data ?? [],
    reservations: reservations.data ?? [],
    incidents: incidents.data ?? [],
  };
}

export const boardQuery = {
  queryKey: ["board"] as const,
  queryFn: fetchBoard,
};

/** Crates committed to a locker by reservations that still occupy space. */
export function usedCrates(lockerId: string, reservations: Reservation[]): number {
  return reservations
    .filter((r) => r.locker_id === lockerId && ACTIVE_RESERVATION_STATUSES.includes(r.status))
    .reduce((sum, r) => sum + r.crate_count, 0);
}

export function freeCrates(locker: Locker, reservations: Reservation[]): number {
  return Math.max(0, locker.capacity - usedCrates(locker.id, reservations));
}

export function isReservable(locker: Locker, reservations: Reservation[]): boolean {
  if (locker.status === "MAINTENANCE" || locker.status === "BREAKDOWN") return false;
  return freeCrates(locker, reservations) > 0;
}

export const LOCKER_LABEL: Record<LockerStatus, string> = {
  AVAILABLE: "Free",
  RESERVED: "Booked",
  IN_STORAGE: "In storage",
  MAINTENANCE: "Maintenance",
  BREAKDOWN: "Broken",
};

export const RESERVATION_LABEL: Record<ReservationStatus, string> = {
  RESERVED: "Booked",
  CHECKED_IN: "Checked in",
  STORED: "Stored",
  PICKED_UP: "Picked up",
  CANCELLED: "Cancelled",
};

export function statusTone(status: LockerStatus): string {
  switch (status) {
    case "AVAILABLE":
      return "tone-free";
    case "RESERVED":
      return "tone-booked";
    case "IN_STORAGE":
      return "tone-stored";
    case "MAINTENANCE":
      return "tone-warn";
    case "BREAKDOWN":
      return "tone-down";
  }
}

export function reservationTone(status: ReservationStatus): string {
  switch (status) {
    case "RESERVED":
      return "tone-booked";
    case "CHECKED_IN":
      return "tone-stored";
    case "STORED":
      return "tone-stored";
    case "PICKED_UP":
      return "tone-free";
    case "CANCELLED":
      return "tone-muted";
  }
}

export function shortTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
