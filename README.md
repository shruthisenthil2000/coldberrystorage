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
cache read-only, shows an obvious offline banner with the last sync time, and
blocks writes with a plain explanation rather than pretending a booking
succeeded. Coming back online triggers "Back online — syncing…" and a refetch.
This deliberately avoids optimistic offline reservations: capacity is shared, so
an unconfirmed booking would risk duplicates and overbooking.

## 7. Overbooking and concurrency

Capacity is never stored as a mutable counter. It is computed as
`capacity − SUM(crate_count)` over active reservations. On insert/update a
`BEFORE` trigger takes `SELECT ... FOR UPDATE` on the locker row, recomputes
usage, and raises `CAPACITY:<n>` if the request would exceed it. Two
simultaneous bookings therefore serialise: the second one sees the first and
is either trimmed or rejected, and the UI offers "Reserve the remaining N".

## 8. Incident handling

Quick incident types (door open, cooling failure, temperature high, damage,
other) with an optional note. Critical types mark the locker out of service, so
new reservations are blocked with the reason shown on the card. Existing
reservations are **never** deleted — they stay visible with a warning so the
farmer can retrieve or re-book crates.

## 9. Fair allocation

First-come, first-served. Capacity is only held for 45 minutes; a no-show
releases it back to the community automatically. No priority tiers, no queueing.

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
