# Observations — Existing Booking Flow

## 1. Booking Request Flow — Observed

The standard booking path follows this sequence:

```
POST /api/book/event
        ↓
RegularBookingService.createBooking()
        ↓
ensureAvailableUsers()
        ↓
getUserAvailability() / _getBusyTimes()
        ↓
checkForConflicts()
        ↓
createBooking()
        ↓
saveBooking()
        ↓
tx.booking.create()
```

### Component Responsibilities

| Step | Component | Role |
| :--- | :--- | :--- |
| 1 | `POST /api/book/event` | HTTP entry point; receives booking request payload |
| 2 | `RegularBookingService.createBooking()` | Orchestrates the full booking lifecycle |
| 3 | `ensureAvailableUsers()` | Filters eligible hosts; triggers availability check |
| 4 | `getUserAvailability()` / `_getBusyTimes()` | Reads existing bookings + working hours; applies buffers; returns busy intervals |
| 5 | `checkForConflicts()` | Compares requested slot against busy intervals; throws `NoAvailableUsersFound` on overlap |
| 6 | `createBooking()` / `saveBooking()` | Constructs the booking record |
| 7 | `tx.booking.create()` | Writes the booking to the database inside a Prisma transaction |

---

## 2. Pre-Booking Availability Check — Observed

**[OBSERVED]** The availability check (steps 3–5 above) runs **before and outside** the database transaction in step 7.

- `ensureAvailableUsers()` queries busy times and evaluates conflicts at the application layer.
- Only after this check passes does execution reach `tx.booking.create()`.

---

## 3. Conflict Detection — Observed

**[OBSERVED]** `checkForConflicts()` compares the requested `[startTime, endTime]` window against the calculated set of busy intervals.

- Works correctly under **sequential** request conditions.
- If Request A has already committed its booking, a later Request B will see that booking in `_getBusyTimes()` and be correctly rejected.

---

## 4. Race Condition — Inferred

**[INFERRED]** The separation between the pre-booking availability check and the final database insertion creates a **Time-of-Check / Time-of-Use (TOCTOU) race condition** under concurrent requests.

### Race Condition Scenario

```
Request A                        Request B                    Database
─────────                        ─────────                    ────────
1. checkForConflicts()
   → slot is AVAILABLE
                                 1. checkForConflicts()
                                    → slot is AVAILABLE
2. tx.booking.create()
   → Booking A written                                        [Booking A committed]
                                 2. tx.booking.create()
                                    → Booking B written       [Booking B committed]
                                                              ← DOUBLE BOOKING ✗
```

Both requests passed the pre-booking availability check before either INSERT completed. Both bookings are now in the database for the same slot.

### Why the Transaction Alone Does Not Prevent This

The `prisma.$transaction(...)` call wraps **only the INSERT operation**, not the availability check. A standard `READ COMMITTED` transaction (the default isolation level) prevents dirty reads but does **not** prevent two concurrent transactions from each reading the same "free" state and both committing.

The transaction would need to either:
- Re-verify availability **inside** the transaction boundary under a lock, or
- Use `SERIALIZABLE` isolation and handle serialization failures, or
- Rely on a **database-level exclusion constraint** on overlapping `[startTime, endTime)` ranges.

None of these mechanisms were observed in the reference implementation.

---

## 5. Additional Observations

### Idempotency Key [OBSERVED]
- The `Booking` model includes an `idempotencyKey` field with a `@unique` constraint.
- This prevents a **single client** from accidentally creating duplicates via retry.
- It does **not** prevent **two distinct clients** from booking the same slot simultaneously with different keys.

### No Database-Level Slot Overlap Constraint [OBSERVED]
- The `Booking` table has no GiST range exclusion constraint such as:
  ```sql
  EXCLUDE USING gist (
      "facultyId" WITH =,
      tsrange("startTime", "endTime") WITH &&
  )
  ```
- The database layer alone cannot reject overlapping concurrent inserts.

### Sequential Behaviour — Works Correctly [OBSERVED]
- For requests arriving one at a time, the flow correctly rejects duplicates because `_getBusyTimes()` reads committed bookings before the conflict check.

---

## 6. Summary

| Behaviour | Status |
| :--- | :--- |
| Sequential conflict detection | **Works correctly** |
| Client-side retry deduplication (idempotency key) | **Works when key is provided** |
| Concurrent double-booking prevention | **Not protected — race condition exists** |
| Database-level slot overlap constraint | **Not present** |
| Natural-language booking | **Not present — proposed feature** |
| Smart no-show reminder logic | **Not present — proposed feature** |
