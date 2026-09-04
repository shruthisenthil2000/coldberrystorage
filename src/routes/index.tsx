import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  boardQuery,
  freeCrates,
  isReservable,
  usedCrates,
  LOCKER_LABEL,
  RESERVATION_LABEL,
  reservationTone,
  shortTime,
  statusTone,
  type BoardData,
  type Locker,
} from "@/lib/board";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Cold Locker Board — Shared Berry Cold Storage" },
      {
        name: "description",
        content:
          "Live board of shared cold-storage lockers for berry farmers: crate space, bookings, pickup codes and breakdown reports.",
      },
      { property: "og:title", content: "Cold Locker Board — Shared Berry Cold Storage" },
      {
        property: "og:description",
        content:
          "Live board of shared cold-storage lockers for berry farmers: crate space, bookings, pickup codes and breakdown reports.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Board,
});

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

function LockerCard({ locker, data }: { locker: Locker; data: BoardData }) {
  const used = usedCrates(locker.id, data.reservations);
  const free = freeCrates(locker, data.reservations);
  const open = isReservable(locker, data.reservations);
  const active = data.reservations.filter(
    (r) =>
      r.locker_id === locker.id && ["RESERVED", "CHECKED_IN", "STORED"].includes(r.status),
  );
  const incidents = data.incidents.filter(
    (i) => i.locker_id === locker.id && i.status !== "RESOLVED",
  );
  const tempOff = Number(locker.temperature) > 5;

  return (
    <article className="panel p-4">
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
      <p className="mt-2 text-sm font-semibold">
        {open ? `${free} crate${free === 1 ? "" : "s"} free` : "Not bookable"}
      </p>

      <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-sm">
        <span className="stat-label">Temp</span>
        <span className={tempOff ? "font-bold text-destructive" : "font-bold"}>
          {Number(locker.temperature).toFixed(1)} °C
        </span>
      </div>

      {active.length > 0 && (
        <ul className="mt-3 space-y-2 border-t border-border pt-3">
          {active.map((r) => {
            const farmer = data.farmers.find((f) => f.id === r.farmer_id);
            return (
              <li key={r.id} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{farmer?.farm_name ?? "Unknown farm"}</span>
                  <Chip tone={reservationTone(r.status)}>{RESERVATION_LABEL[r.status]}</Chip>
                </div>
                <p className="text-muted-foreground">
                  {r.crate_count} crates · {r.slot}
                </p>
                <p className="text-muted-foreground">
                  {r.status === "RESERVED"
                    ? `Drop-off code ${r.dropoff_code} · by ${shortTime(r.check_in_deadline)}`
                    : `Pickup code ${r.pickup_code}`}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {incidents.length > 0 && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
          {incidents.map((i) => (
            <p key={i.id}>
              <span className="font-bold">{i.type}</span> — {i.description}
            </p>
          ))}
        </div>
      )}
    </article>
  );
}

function Board() {
  const { data, isPending, error } = useQuery(boardQuery);

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 pt-5 pb-16">
      <header>
        <p className="stat-label">Shared cold storage</p>
        <h1 className="font-display text-4xl leading-none font-bold tracking-tight">
          Locker Board
        </h1>
      </header>

      {isPending && <p className="mt-8 text-muted-foreground">Loading the board…</p>}
      {error && (
        <p className="mt-8 font-semibold text-destructive">
          The board couldn't load. Check your connection and pull to refresh.
        </p>
      )}

      {data && (
        <>
          <section className="mt-4 grid grid-cols-3 gap-2">
            {(
              [
                ["Free lockers", data.lockers.filter((l) => isReservable(l, data.reservations)).length],
                [
                  "Crates free",
                  data.lockers.reduce(
                    (s, l) => s + (isReservable(l, data.reservations) ? freeCrates(l, data.reservations) : 0),
                    0,
                  ),
                ],
                ["Open issues", data.incidents.filter((i) => i.status !== "RESOLVED").length],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="panel p-3">
                <p className="stat-label">{label}</p>
                <p className="font-display text-3xl font-bold">{value}</p>
              </div>
            ))}
          </section>

          <section className="mt-4 grid gap-3 sm:grid-cols-2">
            {data.lockers.map((locker) => (
              <LockerCard key={locker.id} locker={locker} data={data} />
            ))}
          </section>

          <section className="mt-8">
            <h2 className="font-display text-2xl font-bold tracking-tight">Recent bookings</h2>
            <ul className="mt-3 space-y-2">
              {data.reservations.slice(0, 8).map((r) => {
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
