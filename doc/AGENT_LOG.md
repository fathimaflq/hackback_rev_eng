# Agent Log — Smart Slot Booking

**Project**: Smart Slot Booking  
**Purpose**: Record of investigation, reasoning, decisions, and planned implementation steps.

---

## Phase 1 — Initial Project Understanding

**Date**: 2026-10-05

### Task
Understand the core problem domain: faculty–student appointment booking for educational institutions.

### Key Observations
- The core problem is not just "build a booking system" but rather address specific, verifiable failure modes: double booking, friction in finding slots, and student no-shows.
- An existing open-source scheduling implementation (`cal.diy`) was studied to understand the state of the art and identify gaps.

### Decision
Scope the project to three targeted features that address real, demonstrable problems rather than building a general-purpose scheduling platform.

---

## Phase 2 — Existing Booking Flow Investigation

**Date**: 2026-10-05

### Task
Trace the booking request pipeline in the reference implementation to understand the data flow and identify potential weaknesses.

### Traced Flow

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
createBooking() → saveBooking() → tx.booking.create()
```

### Key Finding
The availability check and the database INSERT are two separate, non-atomic operations. The `prisma.$transaction(...)` wraps only the INSERT, not the re-validation.

---

## Phase 3 — Concurrency Issue Investigation

**Date**: 2026-10-05

### Task
Determine whether the existing flow can result in double bookings under concurrent requests.

### Analysis

Under sequential conditions: works correctly. A committed booking is visible to `_getBusyTimes()`, so a later request correctly detects the conflict.

Under concurrent conditions (TOCTOU race):
1. Request A checks availability → free.
2. Request B checks availability → free (before A commits).
3. Request A inserts booking.
4. Request B inserts booking.
5. Result: double booking.

### Supporting Evidence
- `prisma.$transaction` uses `READ COMMITTED` by default — prevents dirty reads, does NOT prevent the above race.
- No `SELECT FOR UPDATE` locking observed.
- No SERIALIZABLE isolation observed.
- No GiST range exclusion constraint on `Booking(facultyId, startTime, endTime)` observed.

### Decision
Make **concurrency-safe booking** Feature 1 — it is the most critical correctness requirement.

---

## Phase 4 — Feature Selection

**Date**: 2026-10-05

### Three Features Selected

After evaluating the problem space, the following three features were chosen:

| # | Feature | Rationale |
| :--- | :--- | :--- |
| 1 | Concurrency-safe booking | Correctness — double bookings erode trust in the entire system |
| 2 | Natural-language booking | Usability — reduces friction in finding and booking slots |
| 3 | Smart no-show reminders | Efficiency — recovers wasted faculty time from no-shows |

### Important Decision: No-Show Reminders Are Rule-Based

An early consideration was whether to use ML to predict no-shows. This was explicitly rejected for the following reasons:
- Insufficient training data in a typical institutional deployment.
- Adds complexity without proportionate benefit.
- A simple rule (`no_show_count >= 2`) is transparent, auditable, and immediately effective.

**Final decision**: No-show reminders are **rule-based only**. The threshold is `no_show_count >= 2`.

### Important Decision: NL Parser Does Not Determine Availability

The natural-language parser's scope is strictly limited to **text-to-filter conversion**. It does not:
- Query or interpret calendar data.
- Decide what is available.
- Confirm bookings autonomously.

The Availability Service remains the single source of truth.

---

## Phase 5 — Planned Architecture

**Date**: 2026-10-05

### Components Designed (Not Yet Implemented)

| Component | Role |
| :--- | :--- |
| Availability Service | Query free slots; source of truth |
| Natural Language Parser | Text → structured filters only |
| No-Show Reminder Logic | Rule-based escalation for repeat no-shows |
| Atomic Booking Guard | Atomic check + insert; prevents double booking |
| API Layer | REST endpoints |
| Database | PostgreSQL + Prisma (proposed) |

### Key Architectural Principle
The Atomic Booking Guard must prevent concurrent double-booking at the database/transaction level — application-layer checks alone are insufficient.

---

## Phase 6 — Documentation Phase

**Date**: 2026-10-05

### Task
Produce complete, honest documentation before implementation begins.

### Files Created

| File | Content |
| :--- | :--- |
| `docs/OBSERVATIONS.md` | Existing booking flow + concurrency race analysis |
| `docs/PRD.md` | Product requirements for the three features |
| `docs/ARCHITECTURE.md` | Proposed component architecture + diagrams |
| `docs/DATA_MODEL.md` | Proposed database schema + concurrency constraint |
| `docs/API.md` | Planned API endpoints with request/response specs |
| `docs/GAPS.md` | Gap analysis: current vs. proposed |
| `docs/AGENT_LOG.md` | This file |
| `README.md` | Project overview and entry point |
| `SUBMISSION.md` | Submission summary document |
| `.env.example` | Environment variable template |
| `deck.pdf` | Presentation slides |

### Documentation Rules Enforced
- `OBSERVED / EXISTING` clearly separated from `PROPOSED / NEW`.
- No invented test results, performance numbers, or database constraints.
- No claims that features are implemented when they are not.

---

## Phase 7 — Planned Implementation Steps (Future)

The following implementation steps are planned but **not yet started**:

1. **Set up project**: TypeScript + Next.js (or Express) + Prisma + PostgreSQL.
2. **Implement Availability Service**: Query FacultySchedule and existing Bookings; return free slots.
3. **Implement Atomic Booking Guard**: Choose and implement atomic mechanism (GiST constraint preferred).
4. **Implement Natural Language Parser**: Integrate LLM API for text-to-filter extraction; validate output.
5. **Implement No-Show Reminder Logic**: Count no-shows from booking history; apply threshold; schedule reminders.
6. **Build API Layer**: Implement all five planned endpoints.
7. **Write Tests**:
   - Unit tests: NL parser extraction, no-show count logic, slot computation.
   - Integration tests: concurrent booking requests (verify exactly one `201`, one `409`).
8. **Build minimal UI**: Slot picker, NL input field, booking confirmation, reminder UI.
9. **Update documentation**: Add setup/run instructions to README.

---

## Important Decisions Summary

| Decision | Rationale |
| :--- | :--- |
| Feature 1: Concurrency-safe booking | Critical correctness — prevents double bookings |
| Feature 2: Natural-language booking | Reduces booking friction |
| Feature 3: Smart no-show reminders | Recovers wasted time; rule-based for transparency |
| No-show logic is rule-based, not ML | Simplicity, auditability, no training data needed |
| NL parser is parse-only | Availability engine must remain the source of truth |
| Document before implementing | Establish honest baseline; no invented results |
