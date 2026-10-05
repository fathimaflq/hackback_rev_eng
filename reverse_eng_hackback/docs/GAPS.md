# Gaps Analysis — Smart Slot Booking

**Date**: 2026-10-05

This document identifies the gaps between the existing/observed booking flow and the requirements of the Smart Slot Booking system. For each gap, the current observed behaviour is described, followed by the proposed fix.

---

## Gap 1 — Concurrency Race Condition (Double Booking)

### CURRENT / OBSERVED

The standard booking flow separates the availability check from the database INSERT into two distinct, non-atomic steps:

```
Step 1: ensureAvailableUsers() / checkForConflicts()
        [reads busy times, detects conflicts]
                    ↓
Step 2: tx.booking.create()
        [inserts the booking record]
```

Under concurrent load, two requests for the same slot can interleave:

```
Request A: checkForConflicts() → slot is free
Request B: checkForConflicts() → slot is free
Request A: tx.booking.create() → Booking A inserted
Request B: tx.booking.create() → Booking B inserted  ← double booking
```

**Why the transaction does not help**: The `prisma.$transaction(...)` wraps only the INSERT. It does not re-check availability inside the transaction. At the default `READ COMMITTED` isolation level, this provides no protection against the above interleaving.

**Database-level observation**: No GiST range exclusion constraint or equivalent exists on the `Booking` table to prevent overlapping `[startTime, endTime)` rows for the same faculty.

---

### PROPOSED FIX

1. Move the availability re-check **inside** the atomic boundary (transaction or lock scope).
2. Add a database-level exclusion constraint as a defense-in-depth fallback:
   ```sql
   EXCLUDE USING gist (
       "facultyId" WITH =,
       tsrange("startTime"::timestamp, "endTime"::timestamp) WITH &&
   ) WHERE (status = 'CONFIRMED')
   ```
3. The losing concurrent request receives `409 Conflict`.

**Requirement reference**: PRD §7 CON-1 through CON-5.

---

## Gap 2 — Availability Check Is Separate From Insertion

### CURRENT / OBSERVED

`ensureAvailableUsers()` is called before `createBooking()`. There is no mechanism to ensure that the state of the database has not changed between the availability check completing and the INSERT executing.

### PROPOSED FIX

Implement an **Atomic Booking Guard** that performs the availability re-validation and the INSERT as a single indivisible operation. See [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) §2.6 for options.

---

## Gap 3 — Natural-Language Booking Does Not Exist

### CURRENT / OBSERVED

The existing booking flow requires a student to navigate a slot picker manually. There is no mechanism to accept free-text booking requests.

### PROPOSED FIX

Introduce a **Natural Language Parser** component that:
1. Accepts free-text input.
2. Extracts structured filters: `{ faculty, duration, date, timeRange }`.
3. Passes those filters to the standard Availability Service.
4. Returns available matching slots to the student for explicit selection.

**Key constraint**: The parser does **not** determine availability or confirm bookings autonomously. Availability remains deterministic.

**Requirement reference**: PRD §7 NL-1 through NL-5.

---

## Gap 4 — No Smart No-Show Reminder Logic

### CURRENT / OBSERVED

No mechanism exists to track student no-shows and escalate reminder behaviour based on history.

### PROPOSED FIX

Implement rule-based no-show logic:

1. Track `NO_SHOW` outcomes in booking records.
2. Before sending appointment reminders, check: `no_show_count >= 2`.
3. If threshold is met: send earlier reminder, include "Release My Slot" option.
4. This is **rule-based** — no machine learning or predictive model.

**Requirement reference**: PRD §7 NS-1 through NS-5.

---

## Gap 5 — No Release-Slot Functionality

### CURRENT / OBSERVED

Cancellation flows exist in standard booking systems, but the specific "Release My Slot" workflow (triggered by a no-show reminder with a one-tap action) does not exist in the observed implementation.

### PROPOSED FIX

Add `POST /api/bookings/:id/release`:
- Updates booking status to `CANCELLED`.
- Makes the slot immediately available for other students.

This endpoint is surfaced in the no-show reminder as a direct action.

**Requirement reference**: PRD §7 NS-3, NS-4. API §4.

---

## Gap Summary

| # | Gap | Current State | Proposed Fix |
| :--- | :--- | :--- | :--- |
| 1 | Concurrent double-booking | Race condition possible | Atomic booking guard + DB exclusion constraint |
| 2 | Check/insert separation | Non-atomic | Re-check inside atomic boundary |
| 3 | Natural-language booking | Does not exist | NL Parser → Availability Service |
| 4 | Smart no-show reminders | Does not exist | Rule-based threshold logic |
| 5 | Release-slot action | Does not exist | POST /api/bookings/:id/release |
