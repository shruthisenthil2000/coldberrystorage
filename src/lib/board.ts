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
  /** When this snapshot was fetched from the server. */
  syncedAt: string;
  /** True when the snapshot came from the local cache, not a live read. */
  fromCache: boolean;
};

const BOARD_CACHE_KEY = "coldstore:board-cache";

export function readCachedBoard(): BoardData | null {
  try {
    const raw = localStorage.getItem(BOARD_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BoardData;
    if (!parsed || !Array.isArray(parsed.lockers)) return null;
    return { ...parsed, fromCache: true };
  } catch {
    return null;
  }
}

function writeCachedBoard(data: BoardData): void {
  try {
    localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable — the app still works, just without offline cache */
  }
}

export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export async function fetchBoard(): Promise<BoardData> {
  // Offline: serve the last synced snapshot instead of failing the whole board.
  if (isOffline()) {
    const cached = readCachedBoard();
    if (cached) return cached;
    throw new Error("You're offline and no locker information has been saved yet.");
  }

  try {
    // Lazy expiration: release RESERVED reservations whose 45-minute check-in
    // deadline has passed BEFORE computing availability. Runs on every board
    // load/refresh, so expired capacity is freed without any background job.
    await expireOverdueReservations();

    const [lockers, farmers, reservations, incidents] = await Promise.all([
      supabase.from("lockers").select("*").order("locker_number"),
      supabase.from("farmers").select("*").order("name"),
      supabase.from("reservations").select("*").order("reserved_at", { ascending: false }),
      supabase.from("incidents").select("*").order("reported_at", { ascending: false }),
    ]);

    const error = lockers.error || farmers.error || reservations.error || incidents.error;
    if (error) throw error;

    const fresh: BoardData = {
      lockers: lockers.data ?? [],
      farmers: farmers.data ?? [],
      reservations: reservations.data ?? [],
      incidents: incidents.data ?? [],
      syncedAt: new Date().toISOString(),
      fromCache: false,
    };
    writeCachedBoard(fresh);
    return fresh;
  } catch (err) {
    // Flaky network: fall back to the cached snapshot, clearly marked as stale.
    const cached = readCachedBoard();
    if (cached) return cached;
    throw err;
  }
}

/** Cancel every RESERVED reservation past its check-in deadline, releasing its crates. */
export async function expireOverdueReservations(now: Date = new Date()): Promise<void> {
  const nowIso = now.toISOString();
  await supabase
    .from("reservations")
    .update({ status: "CANCELLED", cancelled_at: nowIso })
    .eq("status", "RESERVED")
    .lt("check_in_deadline", nowIso);
}

export const boardQuery = {
  queryKey: ["board"] as const,
  queryFn: fetchBoard,
  // Re-check (and lazily expire) while the page stays open.
  refetchInterval: 30_000,
};


/**
 * Crates committed to a locker by reservations that still occupy space.
 * Capacity is tracked per harvest slot: a morning booking does not consume
 * afternoon space. Pass no slot to count every slot together.
 */
export function usedCrates(
  lockerId: string,
  reservations: Reservation[],
  slot?: HarvestSlot,
): number {
  return reservations
    .filter(
      (r) =>
        r.locker_id === lockerId &&
        ACTIVE_RESERVATION_STATUSES.includes(r.status) &&
        (slot === undefined || r.slot === slot),
    )
    .reduce((sum, r) => sum + r.crate_count, 0);
}

export function freeCrates(
  locker: Locker,
  reservations: Reservation[],
  slot?: HarvestSlot,
): number {
  return Math.max(0, locker.capacity - usedCrates(locker.id, reservations, slot));
}

export function isReservable(
  locker: Locker,
  reservations: Reservation[],
  slot?: HarvestSlot,
): boolean {
  if (locker.status === "MAINTENANCE" || locker.status === "BREAKDOWN") return false;
  return freeCrates(locker, reservations, slot) > 0;
}

/** Headline numbers for the selected harvest slot. */
export function slotSummary(data: BoardData, slot: HarvestSlot) {
  const usable = data.lockers.filter((l) => !isOutOfService(l));
  const lockersFree = usable.filter((l) => freeCrates(l, data.reservations, slot) > 0).length;
  const cratesFree = usable.reduce((sum, l) => sum + freeCrates(l, data.reservations, slot), 0);
  return { lockersFree, cratesFree, outOfService: data.lockers.length - usable.length };
}

/** "just now" / "12s ago" / "4 min ago" — for the live sync indicator. */
export function agoLabel(iso: string, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

/**
 * Move a still-RESERVED booking to another locker after a breakdown. The
 * original locker is recorded so the move stays auditable.
 */
export async function moveReservation(
  reservation: Reservation,
  targetLockerId: string,
): Promise<Reservation> {
  const { data, error } = await supabase
    .from("reservations")
    .update({
      locker_id: targetLockerId,
      moved_from_locker_id: reservation.locker_id,
      moved_at: new Date().toISOString(),
    })
    .eq("id", reservation.id)
    .eq("status", "RESERVED")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("This booking can no longer be moved.");
  return data;
}


/** The only four locker states the farmer ever sees. */
export const LOCKER_LABEL: Record<LockerStatus, string> = {
  AVAILABLE: "Available",
  RESERVED: "Booked",
  IN_STORAGE: "In storage",
  MAINTENANCE: "Out of service",
  BREAKDOWN: "Out of service",
};

/** True when the locker cannot take new crates for any reason. */
export function isOutOfService(locker: Locker): boolean {
  return locker.status === "MAINTENANCE" || locker.status === "BREAKDOWN";
}

export const RESERVATION_LABEL: Record<ReservationStatus, string> = {
  RESERVED: "Booked",
  CHECKED_IN: "Checked in",
  STORED: "Stored",
  PICKED_UP: "Picked up",
  CANCELLED: "Cancelled",
};

export type TempState = "SAFE" | "CHECK" | "ALERT";

/** Plain-language temperature status shown on the locker card. */
export const TEMP_LABEL: Record<TempState, string> = {
  SAFE: "Normal",
  CHECK: "High",
  ALERT: "Cooling failure",
};

export function tempState(temperature: number): TempState {
  if (temperature > 5) return "ALERT";
  if (temperature > 4) return "CHECK";
  return "SAFE";
}


export function tempTone(state: TempState): string {
  switch (state) {
    case "SAFE":
      return "tone-free";
    case "CHECK":
      return "tone-booked";
    case "ALERT":
      return "tone-down";
  }
}

export type HarvestSlot = "MORNING" | "AFTERNOON";

export const SLOT_LABEL: Record<HarvestSlot, string> = {
  MORNING: "Morning",
  AFTERNOON: "Afternoon",
};

/** Reservations must be checked in within 45 minutes of booking. */
export const CHECK_IN_WINDOW_MINUTES = 45;

export function checkInDeadline(from: Date = new Date()): string {
  return new Date(from.getTime() + CHECK_IN_WINDOW_MINUTES * 60_000).toISOString();
}

export function clockTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}


export function statusTone(status: LockerStatus): string {
  switch (status) {
    case "AVAILABLE":
      return "tone-free";
    case "RESERVED":
      return "tone-booked";
    case "IN_STORAGE":
      return "tone-stored";
    case "MAINTENANCE":
      // Maintenance and breakdown both read as OUT OF SERVICE, so they share a colour.
      return "tone-down";
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

/* ---------------------------------------------------------------- incidents */

export type IncidentType = Incident["type"];
export type IncidentStatus = Incident["status"];

export type IncidentOption = {
  /** Value stored in the incidents table. */
  type: IncidentType;
  /** Short label shown in the report form. */
  label: string;
  /**
   * Locker state applied when this problem is reported. `null` keeps the
   * locker bookable (minor issues are logged only).
   */
  blocks: LockerStatus | null;
  /** Color cue: caution = blocks maintenance, critical = blocks booking, minor = logged only. */
  tone: "caution" | "critical" | "minor";
};

export const INCIDENT_OPTIONS: IncidentOption[] = [
  { type: "DOOR", label: "Door left open", blocks: "MAINTENANCE", tone: "caution" },
  { type: "POWER", label: "Cooling failure", blocks: "BREAKDOWN", tone: "critical" },
  { type: "TEMPERATURE", label: "Temperature too high", blocks: "BREAKDOWN", tone: "critical" },
  { type: "SPOILAGE", label: "Locker damaged", blocks: "BREAKDOWN", tone: "critical" },
  { type: "OTHER", label: "Other", blocks: null, tone: "minor" },
];

export const INCIDENT_LABEL: Record<IncidentType, string> = {
  DOOR: "Door left open",
  POWER: "Cooling failure",
  TEMPERATURE: "Temperature too high",
  SPOILAGE: "Locker damaged",
  OTHER: "Other issue",
};

/** Unresolved incidents recorded against a locker. */
export function openIncidents(lockerId: string, incidents: Incident[]): Incident[] {
  return incidents.filter((i) => i.locker_id === lockerId && i.status !== "RESOLVED");
}

/**
 * Record an incident and, when the problem affects storage safety, stop the
 * locker from taking NEW reservations. Existing crates are never touched.
 */
export async function reportIncident(input: {
  lockerId: string;
  type: IncidentType;
  description: string;
}): Promise<Incident> {
  const option = INCIDENT_OPTIONS.find((o) => o.type === input.type);
  const { data, error } = await supabase
    .from("incidents")
    .insert({
      locker_id: input.lockerId,
      type: input.type,
      description: input.description.trim() || INCIDENT_LABEL[input.type],
    })
    .select("*")
    .single();
  if (error) throw error;

  if (option?.blocks) {
    const { error: lockerError } = await supabase
      .from("lockers")
      .update({ status: option.blocks })
      .eq("id", input.lockerId)
      .not("status", "in", "(MAINTENANCE,BREAKDOWN)");
    if (lockerError) throw lockerError;
  }

  return data;
}

/* ------------------------------------------------- reservation presentation */

export type DisplayStatus =
  | "RESERVED"
  | "CHECK_IN_REQUIRED"
  | "IN_STORAGE"
  | "COMPLETED"
  | "EXPIRED"
  | "CANCELLED";

export const DISPLAY_STATUS_LABEL: Record<DisplayStatus, string> = {
  RESERVED: "Reserved",
  CHECK_IN_REQUIRED: "Check-in required",
  IN_STORAGE: "In storage",
  COMPLETED: "Completed",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

/** Minutes left on the check-in window before a reservation is treated as urgent. */
const URGENT_MINUTES = 15;

export function displayStatus(r: Reservation, now: number = Date.now()): DisplayStatus {
  switch (r.status) {
    case "RESERVED": {
      const left = new Date(r.check_in_deadline).getTime() - now;
      if (left <= 0) return "EXPIRED";
      return left <= URGENT_MINUTES * 60_000 ? "CHECK_IN_REQUIRED" : "RESERVED";
    }
    case "CHECKED_IN":
    case "STORED":
      return "IN_STORAGE";
    case "PICKED_UP":
      return "COMPLETED";
    case "CANCELLED":
      return r.checked_in_at ? "CANCELLED" : "EXPIRED";
  }
}

export function displayTone(status: DisplayStatus): string {
  switch (status) {
    case "RESERVED":
      return "tone-booked";
    case "CHECK_IN_REQUIRED":
      return "tone-down";
    case "IN_STORAGE":
      return "tone-stored";
    case "COMPLETED":
      return "tone-free";
    case "EXPIRED":
      return "tone-down";
    case "CANCELLED":
      return "tone-muted";
  }
}

/** "32:14" style countdown; returns null once the deadline has passed. */
/** Under this many minutes the check-in countdown is shown as urgent. */
export const CRITICAL_MINUTES = 10;

export function isCheckInUrgent(deadline: string, now: number = Date.now()): boolean {
  const ms = new Date(deadline).getTime() - now;
  return ms > 0 && ms <= CRITICAL_MINUTES * 60_000;
}

export function formatCountdown(deadline: string, now: number = Date.now()): string | null {
  const ms = new Date(deadline).getTime() - now;
  if (ms <= 0) return null;
  const total = Math.floor(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/* -------------------------------------------------------------- activity log */

export type ActivityEvent = {
  id: string;
  at: string;
  title: string;
  detail: string;
  tone: string;
};

/**
 * Derive the activity feed from the recorded state timestamps. Every
 * transition the app performs writes a timestamp, so no separate event table
 * is needed for the prototype.
 */
export function buildActivity(data: BoardData, now: number = Date.now()): ActivityEvent[] {
  const lockerOf = (id: string) =>
    data.lockers.find((l) => l.id === id)?.locker_number ?? "—";
  const farmerOf = (id: string) => data.farmers.find((f) => f.id === id)?.farm_name ?? "A farm";
  const events: ActivityEvent[] = [];

  for (const r of data.reservations) {
    const crates = `${r.crate_count} crate${r.crate_count === 1 ? "" : "s"}`;
    events.push({
      id: `${r.id}-created`,
      at: r.reserved_at,
      title: "Reservation created",
      detail: `Locker ${lockerOf(r.locker_id)} · ${crates} · ${farmerOf(r.farmer_id)}`,
      tone: "tone-booked",
    });
    if (r.moved_at && r.moved_from_locker_id) {
      events.push({
        id: `${r.id}-moved`,
        at: r.moved_at,
        title: "Reservation moved",
        detail: `${lockerOf(r.moved_from_locker_id)} → ${lockerOf(r.locker_id)} · ${crates}`,
        tone: "tone-booked",
      });
    }

    if (r.checked_in_at) {
      events.push({
        id: `${r.id}-checkin`,
        at: r.checked_in_at,
        title: "Drop-off confirmed",
        detail: `Locker ${lockerOf(r.locker_id)} · ${crates} moved into storage`,
        tone: "tone-stored",
      });
    }
    if (r.picked_up_at) {
      events.push({
        id: `${r.id}-pickup`,
        at: r.picked_up_at,
        title: "Pickup completed",
        detail: `Locker ${lockerOf(r.locker_id)} · ${crates} released`,
        tone: "tone-free",
      });
    }
    if (r.cancelled_at) {
      const expired = !r.checked_in_at;
      events.push({
        id: `${r.id}-cancel`,
        at: r.cancelled_at,
        title: expired ? "Reservation expired" : "Reservation cancelled",
        detail: expired
          ? `Locker ${lockerOf(r.locker_id)} · ${crates} released back to community storage`
          : `Locker ${lockerOf(r.locker_id)} · ${crates}`,
        tone: expired ? "tone-down" : "tone-muted",
      });
    }
  }

  for (const i of data.incidents) {
    const resolved = i.status === "RESOLVED";
    const blocks = INCIDENT_OPTIONS.find((o) => o.type === i.type)?.blocks != null;
    events.push({
      id: `${i.id}-incident`,
      at: i.reported_at,
      title: resolved
        ? `${INCIDENT_LABEL[i.type]} resolved`
        : `${INCIDENT_LABEL[i.type]} reported`,
      detail: resolved
        ? `Locker ${lockerOf(i.locker_id)} · back in service`
        : `Locker ${lockerOf(i.locker_id)} · ${blocks ? "out of service" : "still available"}`,
      tone: resolved ? "tone-free" : "tone-down",
    });
  }

  return events
    .filter((e) => new Date(e.at).getTime() <= now + 60_000)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
