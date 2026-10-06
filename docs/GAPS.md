# Gaps Analysis — Smart Slot Booking

**Date**: 2026-10-05

This document identifies gaps between the existing/observed booking flow and the requirements of the Smart Slot Booking system.

---

## Gap 1 — Concurrency Race Condition (Double Booking) ★ Critical

### CURRENT / OBSERVED

The standard booking flow separates availability checking from database insertion into two non-atomic steps:

```
Step 1: ensureAvailableUsers() / checkForConflicts()   ← outside transaction
                    ↓
Step 2: tx.booking.create()                            ← inside transaction
```

**Race condition under concurrency**:

```
Request A: checkForConflicts() → slot is free
Request B: checkForConflicts() → slot is free   (before A commits)
Request A: tx.booking.create()                  → Booking A inserted
Request B: tx.booking.create()                  → Booking B inserted  ← DOUBLE BOOKED
```

**Why the transaction alone does not prevent this**:

The `prisma.$transaction(...)` in `createBooking.ts:139` wraps only the INSERT:

```typescript
// packages/features/bookings/lib/handleNewBooking/createBooking.ts:139-147
return prisma.$transaction(async (tx) => {
  const booking = await tx.booking.create(createBookingObj);
  return { ...booking, userUuid: booking.user?.uuid ?? null };
});
```

It does **not** re-check availability inside the transaction. At the default `READ COMMITTED` isolation level, this provides no protection against the race described above.

**Database-level observation** (`packages/prisma/schema.prisma:851-870`):

```prisma
model Booking {
  startTime DateTime
  endTime   DateTime
  // No @@unique([userId, startTime, endTime])
  // No EXCLUDE USING gist range constraint
}
```

No range exclusion constraint exists to reject concurrent overlapping inserts at the database level.

### PROPOSED FIX

1. Re-check availability **inside** the atomic transaction boundary.
2. Add a database-level exclusion constraint as defense-in-depth:
   ```sql
   EXCLUDE USING gist (
       "facultyId" WITH =,
       tsrange("startTime"::timestamp, "endTime"::timestamp) WITH &&
   ) WHERE (status = 'CONFIRMED')
   ```
3. The losing concurrent request receives `409 Conflict`.

---

## Gap 2 — FIXME: Overlapping Boundary Bookings Omitted From Limit Checks

### CURRENT / OBSERVED

**Source**: `packages/features/busyTimes/services/getBusyTimes.ts` lines 466–479

```typescript
const where: Prisma.BookingWhereInput = {
  userId: { in: userIds },
  eventTypeId,
  status: BookingStatus.ACCEPTED,
  // FIXME: bookings that overlap on one side will never be counted
  startTime: { gte: startTimeDate },
  endTime:   { lte: endTimeDate },
};
```

The query uses strict `gte`/`lte` bounds. A booking that overlaps the query window on one side (e.g., starts before `startTimeDate` but ends inside it) will not be included in the busy times result. This means the conflict checker may miss edge-case overlapping bookings.

### PROPOSED FIX

The query should use an overlapping range condition:

```typescript
// Correct: include any booking that overlaps [startTimeDate, endTimeDate]
startTime: { lt: endTimeDate },
endTime:   { gt: startTimeDate },
```

---

## Gap 3 — 12-Hour Format String Bug in DST Offset Calculation

### CURRENT / OBSERVED

**Source**: `packages/features/schedules/lib/date-ranges.ts` lines 70–74

```typescript
const offsetBeginningOfDay = dayjs(start.format("YYYY-MM-DD hh:mm")).tz(adjustedTimezone).utcOffset();
const offsetDiff = start.utcOffset() - offsetBeginningOfDay;

start = start.add(offsetDiff, "minute");
end   = end.add(offsetDiff, "minute");
```

`"hh:mm"` is a **12-hour** format code. The correct code for 24-hour time is `"HH:mm"`. For times in the afternoon (PM), this produces an incorrect offset baseline — the DST correction may be applied against an incorrect time representation.

### PROPOSED FIX

Replace `"hh:mm"` with `"HH:mm"` in the format string:

```typescript
const offsetBeginningOfDay = dayjs(start.format("YYYY-MM-DD HH:mm")).tz(adjustedTimezone).utcOffset();
```

---

## Gap 4 — Date Override +/- 1 Day Boundary Workaround (Known Technical Debt)

### CURRENT / OBSERVED

**Source**: `packages/features/schedules/lib/date-ranges.ts` lines 276–289

```typescript
const itemDateAsUtc = dayjs.utc(item.date);
// TODO: Remove the .subtract(1, "day") and .add(1, "day") part and
// refactor this to actually work with correct dates.
// As of 2024-02-20, there are mismatches between local and UTC dates for overrides
// and the dateFrom and dateTo fields, resulting in this if not returning true, which
// results in "no available users found" errors.
if (
  itemDateAsUtc.isBetween(
    dateFrom.subtract(1, "day").startOf("day"),
    dateTo.add(1, "day").endOf("day"),
    null,
    "[]"
  )
)
```

A `TODO` comment explicitly acknowledges that the ±1 day buffer is a workaround for a date mismatch bug, not a correct fix.

### PROPOSED FIX

Resolve the root cause (UTC vs local date mismatch in override records) and remove the artificial boundary expansion.

---

## Gap 5 — Public Unauthenticated Slot Reservation

### CURRENT / OBSERVED

**Source**: `packages/trpc/server/routers/viewer/slots/_router.tsx` lines 26–33

```typescript
reserveSlot: publicProcedure.input(ZReserveSlotInputSchema).mutation(async ({ input, ctx }) => {
  const { reserveSlotHandler } = await import("./reserveSlot.handler");
  return reserveSlotHandler({
    ctx: { ...ctx, req: ctx.req as NextApiRequest, res: ctx.res as NextApiResponse },
    input,
  });
}),
```

`reserveSlot` is exposed as a `publicProcedure`, meaning it requires no authentication. Any unauthenticated caller can reserve slots in the `SelectedSlots` table.

### PROPOSED FIX

Evaluate whether reservation requires authentication. If the intent is to support anonymous checkout flows, add rate limiting and expiry enforcement. If not, protect this procedure behind authentication.

---

## Gap 6 — Unauthenticated Deletion of SelectedSlots via Spoofed UID

### CURRENT / OBSERVED

**Source**: `packages/trpc/server/routers/viewer/slots/_router.tsx` lines 46–55

```typescript
removeSelectedSlotMark: publicProcedure
  .input(ZRemoveSelectedSlotInputSchema)
  .mutation(async ({ input, ctx }) => {
    const { req, prisma } = ctx;
    const uid = req?.cookies?.uid || input.uid;
    if (uid) {
      await prisma.selectedSlots.deleteMany({ where: { uid: { equals: uid } } });
    }
    return;
  }),
```

`removeSelectedSlotMark` is also a `publicProcedure`. It accepts a `uid` from either a cookie or the request body and deletes all matching `SelectedSlots` records. An attacker who knows or guesses another user's `uid` can delete their slot reservation.

### PROPOSED FIX

At minimum, scope the deletion to the authenticated user's records. If the procedure must remain public, bind the `uid` to a server-set cookie only and do not accept it from the request body.

---

## Gap 7 — Missing Features (Not in Original Implementation)

| Feature | Current State | Proposed Fix |
| :--- | :--- | :--- |
| Natural-language booking | Does not exist | NL Parser → structured filters → Availability Engine |
| Smart no-show reminders | Does not exist | Rule-based: `count >= 2` → earlier reminder + release option |
| Release-slot action | No dedicated endpoint | `POST /api/bookings/:id/release` |
| Concurrent double-booking prevention | Race condition confirmed | Atomic Booking Guard (see Gap 1 fix) |

---

## Summary

| # | Gap | Severity | Source Evidence |
| :--- | :--- | :--- | :--- |
| 1 | Concurrency race condition — double booking | **Critical** | `createBooking.ts:139`, `schema.prisma:851` |
| 2 | Overlapping boundary bookings missed in limit check | **High** | `getBusyTimes.ts:466-479` (FIXME comment) |
| 3 | 12-hour format bug in DST offset calculation | **Medium** | `date-ranges.ts:70` (`hh:mm` vs `HH:mm`) |
| 4 | Override date boundary workaround (known tech debt) | **Medium** | `date-ranges.ts:276-289` (TODO comment) |
| 5 | Unauthenticated slot reservation | **Medium** | `slots/_router.tsx:26-33` |
| 6 | Unauthenticated slot deletion via spoofed UID | **High** | `slots/_router.tsx:46-55` |
| 7 | Missing features (NL booking, no-show, release) | **Feature Gap** | Proposed in PRD |
