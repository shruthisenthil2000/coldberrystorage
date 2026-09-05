# ColdStore — Community Cold-Storage Locker Board

A mobile-first board that lets berry farmers reserve shared cold-storage locker
capacity, drop crates off with a verification code, and pick them up again — on
low-end phones, outdoors, on flaky rural connections.

## 1. Product overview

A community cold room is split into lockers. Each locker has a zone, a live
temperature reading and a crate capacity. Farmers reserve crate slots for a
harvest slot (Morning / Afternoon), drop off within 45 minutes, store, and later
collect. Anyone can report a fault, which can take a locker out of service.

## 2. Core user flow

```text
Board → Reserve → 4-digit code → Check in (drop off) → In storage → Pickup → capacity released
```

Home shows the board and, when you have a live booking, an "active reservation"
card with a countdown and the next action. Bookings groups every reservation by
state. Activity is a timestamped log of every transition. Report files incidents.

## 3. Reservation state machine

```text
RESERVED ──check-in code──► CHECKED_IN ──► STORED ──pickup code──► PICKED_UP (Completed)
   │
   ├── deadline passed ─────► CANCELLED (shown as Expired)
   └── cancelled by user ───► CANCELLED
```

Locker state is derived, never hand-set: AVAILABLE → RESERVED → IN_STORAGE by a
database trigger (`sync_locker_status`), plus MAINTENANCE / BREAKDOWN from
incidents. Illegal transitions (pickup before check-in, check-in after expiry,
double pickup, reserving an out-of-service locker, negative capacity) are
rejected by `enforce_reservation_rules` in the database, not just in the UI.

## 4. 45-minute no-show logic

Every reservation stores `check_in_deadline = reserved_at + 45 min`. The UI shows
a live `MM:SS` countdown. Expiration is **lazy**: whenever the board loads, a
booking screen renders, or a new reservation is attempted, `expireOverdueReservations()`
cancels every `RESERVED` row past its deadline, which immediately returns those
crates to available capacity. No cron job, no background worker — the state is
correct whenever anyone looks at it.

## 5. Verification codes

Each reservation carries a `dropoff_code` and a `pickup_code`, both generated as
4-digit values by the database. They are displayed in the app — no SMS or paid
messaging API is used, as required. Drop-off and pickup each verify the code
server-side against the row before transitioning state and recording a timestamp.

## 6. Offline strategy

The last successful board fetch (lockers, reservations, farmers, incidents) is
cached in `localStorage` with a `syncedAt` stamp. Offline, the app renders that
cache read-only ("Offline · Showing last synced data" plus the last sync time),
and labels it "Stale — may have changed" once the cache is older than five
minutes, so old crate counts are never presented as live.

Reservations are never confirmed offline: the reserve sheet shows "You're
offline. Reservation will be confirmed when connection returns." Server-confirmed
availability is always authoritative, which is what keeps two farmers from
taking the same remaining crate space.

Incident reports are safe to queue, so they are: an offline report is stored in
`localStorage` ("Saved locally · waiting for connection") and the banner counts
how many are waiting. On reconnect the app flushes the queue in order, refetches
the board, and confirms "Back online · Synced". Queued items are removed only
after the server accepts them, so a failed send is retried rather than lost, and
a report can never be submitted twice. The header dot reads Live, Syncing…, or
Offline at all times.



## 7. Overbooking and concurrency

Capacity is never stored as a mutable counter. It is computed as
`capacity − SUM(crate_count)` over active reservations. On insert/update a
`BEFORE` trigger takes `SELECT ... FOR UPDATE` on the locker row, recomputes
usage, and raises `CAPACITY:<n>` if the request would exceed it. Two
simultaneous bookings therefore serialise: the second one sees the first and
is either trimmed or rejected, and the UI offers "Reserve the remaining N".

## 8. Incident handling and emergency locker breakdown

Quick incident types (cooling failure, door mechanism failure, door left open,
temperature high, physical damage, other) with an optional note — three taps
from the board. Critical types mark the locker **OUT OF SERVICE** immediately:
it is removed from the reservable pool and from the free-capacity numbers, the
reserve action disappears, and the server re-checks locker status inside the
insert path so a stale screen cannot slip a booking through.

Emergency locker breakdowns immediately remove the affected locker from the
reservable pool and create a visible active incident. If a locker already
contains a crate, the existing reservation and crate allocation are preserved
rather than silently deleted. The locker reads **OUT OF SERVICE — OCCUPIED**,
an emergency banner appears at the top of Home, and the Incidents list shows the
locker, issue type, crates inside, reported time and status. The system surfaces
the issue to staff through the browser interface.

We deliberately did not implement SMS/WhatsApp notifications because the
challenge prohibits paid messaging APIs. As a result, the prototype does not
proactively contact the farmer whose crate is inside a failed locker. This is a
deliberate scope decision: the system prioritizes preserving state, preventing
further bookings, and making the incident visible without pretending that an
external notification was delivered.

**Recovery loop.** Once staff confirms the locker has been fixed ("Mark
resolved" → "Has this locker been inspected and fixed?"), the incident can be
marked resolved. The locker returns to its appropriate previous operational
state rather than automatically becoming available — available → available,
reserved → reserved, occupied → occupied until pickup. This prevents an occupied
locker from incorrectly entering the booking pool.

Offline, an incident is stored on the phone, the locker turns out of service in
the local view straight away, and the report syncs automatically on reconnect;
the cached view never flips back to "Available" while a report is queued.


## 9. Fair allocation

First-come, first-served. Capacity is only held for 45 minutes; a no-show
releases it back to the community automatically. No priority tiers, no queueing.
The rule is stated in plain language under the locker list on Home so nobody has
to guess why their crates were released.

## 9a. Harvest slots are real capacity

Morning (6–11 AM) and Afternoon (12–5 PM) are separate capacity pools. Both the
UI and the database count crates per `(locker, slot)`, so a full morning does not
block the afternoon, and the slot switch on Home changes real numbers rather than
filtering a label. The Home summary answers "can I make the trip to the shed?" in
one line: crates free and lockers with room for the selected slot.

## 9b. Breakdowns and moving a reservation

When a locker goes out of service, new reservations are blocked and existing ones
are never deleted. A booking still awaiting drop-off shows "Your locker is
unavailable", the reported fault, and a **Move reservation** action listing
lockers with enough room in the same slot ("Locker B-01 · 8 crates available ·
0.5 °C · SAFE"). If nothing fits, the app says so honestly instead of failing
silently. The move keeps the same verification code, records the original locker
(`moved_from_locker_id`), and writes an Activity event. Crates already in storage
stay put; the card explains that they are safe.

## 9c. Notifications

In-app only — no SMS, no push, no paid messaging. Toasts confirm reservations,
moves, drop-off, pickup, expiry, incident reports, and connection changes.


## 9d. Trade-offs and edge cases (summary)

These are deliberate product decisions, not gaps:

- **45-minute automatic expiry** — an unclaimed reservation releases its crates
  automatically, so no-shows never block shared community capacity.
- **Full lockers cannot be overbooked** — a locker with no free crates for the
  selected slot shows "No crates available" and offers another locker or slot;
  the reserve action is blocked in the UI and re-checked against the database.
- **Failed or damaged lockers become unavailable** — a cooling failure, high
  temperature or damage report marks the locker unavailable for new reservations
  and shows the reason on the locker card.
- **Offline actions are cached locally** — the last synced board is kept in the
  browser and shown as "Offline · Changes saved locally"; when the connection
  returns the app resyncs and confirms "Back online · Synced".
- **Existing crates are not automatically relocated after an incident** — moving
  real crates needs physical confirmation by a worker, so the app only warns that
  stored crates may need attention rather than silently reassigning them.

## 10. Deliberately not built


- Accounts and authentication — the demo runs as a single known farmer.
- SMS/push notifications (paid messaging APIs are out of scope).
- Payments, invoicing, admin console, multi-site support.
- Offline write queue with conflict resolution (see the offline trade-off above).
- Locker hardware/IoT integration; temperatures are seeded values.

## 11. What breaks at 10x usage

- Full board refetch per load; would need pagination and per-locker subscriptions.
- Lazy expiration relies on traffic; a scheduled job should own it.
- Row-level locking per locker is fine, but a hot locker would serialise writes —
  reservations would move to a queue plus short-lived holds.
- The derived activity feed reads all reservations; it should become an append-only
  events table with an index on time.

## 12. Running locally

```bash
npm install
npm run dev     # http://localhost:8080
```

The backend (Postgres, policies, triggers, seed data) is provisioned by Lovable
Cloud; environment values are supplied automatically. Demo data covers available,
booked, in-storage and out-of-service lockers plus active, completed, expired and
cancelled reservations.

## 13. Live demo

- Preview: _deployment URL to be added after publishing_

## 14. Tech stack

TanStack Start (React 19, Vite 7), Tailwind CSS v4 + shadcn/ui, TanStack Query,
Postgres via Lovable Cloud (RLS, triggers, row-level locking).

## 15. Honest limitations

- **New reservations are blocked while offline** because cached availability
  cannot safely guarantee against double-booking. Only incident reports — which
  are additive and conflict-free — are queued locally.
- **Reservation expiry is lazy**, implemented on reads and actions rather than a
  paid background scheduler. State is correct whenever anyone loads the board,
  opens a booking, or attempts a reservation or check-in.
- **Automatic crate relocation during a locker breakdown is deliberately not
  implemented.** Existing stored crates stay associated with the affected locker;
  only reservations still awaiting drop-off can be moved, by the farmer.

## 16. QA checklist

| # | Flow | Expected |
| --- | --- | --- |
| A | Reserve → drop-off code → pickup code | RESERVED → CHECKED_IN → PICKED_UP, capacity released |
| B | No-show (use the dev-only "simulate check-in window expiring" control) | RESERVED → CANCELLED, crates released, check-in rejected |
| C | Two simultaneous reservations for the last crates | one succeeds, one fails with `CAPACITY:<n>`; capacity never negative |
| D | Double-tap Reserve | button disables; exactly one reservation |
| E/F | Wrong drop-off / pickup code | rejected, no state change |
| G/H | Check in or pick up twice | second attempt rejected (conditional update matches no row) |
| I | Report cooling failure | locker out of service, new reservations blocked, stored crates untouched |
| J | Go offline → reconnect | cached board with "last synced" label, reservation blocked, then "Back online · Synced" |
| K | Reserve → refresh page | reservation still present (state lives in Postgres) |
| L | Reserve / expire / pick up | capacity decreases and increases accordingly |
