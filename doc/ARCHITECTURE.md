# Architecture — Smart Slot Booking

**Status**: Proposed / Planning Phase  

---

## 1. High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                          Student                            │
└──────────────────────────────┬──────────────────────────────┘
                               │  HTTP Request
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                         Frontend                            │
│  - Standard slot picker UI                                  │
│  - Natural-language input field                             │
│  - Booking confirmation view                                │
│  - Reminder notification with "Release My Slot" button      │
└──────────────────────────────┬──────────────────────────────┘
                               │  REST API calls
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                         API Layer                           │
│  GET  /api/slots                                            │
│  POST /api/smart-booking        (NL parse → filters)        │
│  POST /api/bookings             (concurrency-safe create)   │
│  POST /api/bookings/:id/release (release / cancel)          │
│  GET  /api/bookings/history     (for no-show count)         │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                      Booking Service                        │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Availability Service                                 │  │
│  │  - Reads faculty schedules                            │  │
│  │  - Returns free slots for given filters               │  │
│  │  - Source of truth for slot availability              │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Natural Language Parser                              │  │
│  │  - Accepts free-text from student                     │  │
│  │  - Extracts: faculty, duration, date, time range      │  │
│  │  - Returns structured filters ONLY                    │  │
│  │  - Does NOT determine slot availability               │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  No-Show Reminder Logic                               │  │
│  │  - Counts previous no-shows per student               │  │
│  │  - If no_show_count >= 2: escalate reminder timing    │  │
│  │  - Adds "Release My Slot" option to reminder          │  │
│  │  - Rule-based only — no ML                            │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Atomic Booking Guard   ← KEY COMPONENT               │  │
│  │  - Wraps availability re-check + INSERT atomically    │  │
│  │  - Prevents concurrent double-booking                 │  │
│  │  - Options: DB exclusion constraint /                 │  │
│  │    pessimistic lock / serializable transaction        │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                         Database                            │
│  Tables: User, Faculty, Booking, FacultySchedule            │
│  Constraint: No overlapping [startTime, endTime) per        │
│              facultyId (enforced at DB or TX level)         │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Component Descriptions

### 2.1 Frontend
The student-facing UI provides:
- A slot grid / calendar view for browsing faculty availability.
- A natural-language input field for describing booking needs.
- A booking confirmation screen.
- Reminder notifications with, where applicable, a **Release My Slot** button.

> **Status**: Proposed. Not yet implemented.

---

### 2.2 API Layer
A RESTful API layer routes incoming requests to the appropriate service handlers. All booking mutations go through the Booking Service.

See [`docs/API.md`](./API.md) for detailed endpoint documentation.

> **Status**: Proposed. Not yet implemented.

---

### 2.3 Availability Service
- Reads faculty working hours and existing confirmed bookings.
- Computes free slots for a given set of filters (facultyId, date, duration).
- Is the **single source of truth** for slot availability.
- Used by both the standard booking flow and the natural-language booking flow.

> **Status**: Proposed. Not yet implemented.

---

### 2.4 Natural Language Parser

**Role**: Converts a free-text student request into structured booking filters.

**What it does**:
- Receives raw text: `"I need 30 mins with Prof. Rao sometime Thursday afternoon"`
- Extracts: `{ faculty: "Prof. Rao", duration: 30, day: "Thursday", timeRange: "afternoon" }`
- Returns filters to the Availability Service.

**What it does NOT do**:
- It does **not** determine whether a slot is available.
- It does **not** confirm a booking.
- Availability is always determined by the Availability Service using the extracted filters.

This design ensures that the AI component cannot bypass availability logic or create phantom bookings.

> **Status**: Proposed. Not yet implemented.

---

### 2.5 No-Show Reminder Logic

**Role**: Applies rule-based escalation for students with a history of no-shows.

**Rules**:
1. Query booking history and count bookings where `status = NO_SHOW` for the student.
2. If `no_show_count >= 2`:
   - Send the appointment reminder **earlier** than the standard schedule.
   - Include a **"Release My Slot"** option in the reminder.
3. When a student releases their slot:
   - Booking status is updated.
   - Slot becomes available for other students.

> This is **rule-based only**. There is no machine learning or predictive model involved.

> **Status**: Proposed. Not yet implemented.

---

### 2.6 Atomic Booking Guard

**Role**: Ensures that booking creation is free from race conditions.

**The problem it solves**: The standard pattern (check availability → insert booking as separate steps) allows two concurrent requests to both see the slot as free and both succeed.

**Proposed approach** (mechanism to be finalised during implementation):

| Option | Description |
| :--- | :--- |
| A — DB exclusion constraint | Add a GiST range exclusion on `(facultyId, [startTime, endTime))`. Concurrent inserts that overlap fail at the DB level. |
| B — Pessimistic lock | `SELECT ... FOR UPDATE` on a slot lock row before inserting; other requests wait. |
| C — Serializable transaction | Run the re-check + insert inside a `SERIALIZABLE` transaction; abort and retry on serialization failure. |

The chosen mechanism will be documented during implementation.

> **Status**: Proposed. Not yet implemented.

---

### 2.7 Database

**Technology**: PostgreSQL (via Prisma ORM, proposed).

Key design requirements:
- The `Booking` table must enforce that no two confirmed bookings for the same `facultyId` overlap in `[startTime, endTime)`.
- The enforcement mechanism is to be chosen from the options in §2.6.

See [`docs/DATA_MODEL.md`](./DATA_MODEL.md) for the full schema.

---

## 3. Data Flow — Natural Language Booking

```
Student types: "30 mins with Prof. Rao Thursday afternoon"
        ↓
POST /api/smart-booking
        ↓
Natural Language Parser
  → Extracts: { faculty: "Prof. Rao", duration: 30, day: "Thursday", timeRange: "afternoon" }
        ↓
Availability Service
  → Returns: list of matching free slots
        ↓
Response to Frontend
  → Student sees available slots and selects one
        ↓
POST /api/bookings  (standard concurrency-safe booking flow)
        ↓
Booking confirmed
```

---

## 4. Data Flow — Concurrency-Safe Booking

```
POST /api/bookings
        ↓
Booking Service
  → Validate request
  → Compute slot window (apply any buffers)
        ↓
Atomic Booking Guard
  → [Inside atomic boundary]
  → Re-query availability
  → If slot free: INSERT booking
  → If slot taken: return 409 Conflict
        ↓
Database: booking committed or conflict raised
        ↓
Response to client: 201 Created / 409 Conflict
```
