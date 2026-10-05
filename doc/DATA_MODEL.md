# Data Model — Smart Slot Booking

**Status**: Proposed / Planning Phase  
**Date**: 2026-10-05

> All models described here are **proposed**. The database schema has not yet been implemented.

---

## 1. Entities & Fields

### 1.1 User (Student)

```
User
├── id          String   @id @default(cuid())
├── name        String
├── email       String   @unique
├── role        Role     @default(STUDENT)  // STUDENT | FACULTY | ADMIN
├── createdAt   DateTime @default(now())
└── updatedAt   DateTime @updatedAt
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | String (cuid) | Primary key |
| `name` | String | Full name |
| `email` | String (unique) | Login / contact email |
| `role` | Enum | `STUDENT`, `FACULTY`, or `ADMIN` |
| `createdAt` | DateTime | Account creation timestamp |
| `updatedAt` | DateTime | Last updated timestamp |

---

### 1.2 Faculty

```
Faculty
├── id           String   @id @default(cuid())
├── userId       String   @unique  // links to User
├── department   String?
├── createdAt    DateTime @default(now())
└── updatedAt    DateTime @updatedAt
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | String (cuid) | Primary key |
| `userId` | String (FK → User) | The User account for this faculty member |
| `department` | String (optional) | Faculty department / group |

**Note**: Faculty availability/working hours are managed through a separate `FacultySchedule` table (see §1.3).

---

### 1.3 FacultySchedule

```
FacultySchedule
├── id          String   @id @default(cuid())
├── facultyId   String
├── dayOfWeek   Int      // 0 = Sunday … 6 = Saturday
├── startTime   String   // e.g. "09:00" in faculty local timezone
├── endTime     String   // e.g. "17:00"
└── timezone    String   // IANA timezone, e.g. "Asia/Kolkata"
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `facultyId` | String (FK → Faculty) | Owning faculty member |
| `dayOfWeek` | Int | 0 (Sunday) through 6 (Saturday) |
| `startTime` | String | Working hours start (HH:MM, local TZ) |
| `endTime` | String | Working hours end (HH:MM, local TZ) |
| `timezone` | String | IANA timezone for the schedule |

---

### 1.4 Booking

```
Booking
├── id               String        @id @default(cuid())
├── studentId        String
├── facultyId        String
├── startTime        DateTime      // UTC
├── endTime          DateTime      // UTC
├── status           BookingStatus @default(CONFIRMED)
├── idempotencyKey   String?       @unique
├── title            String?
├── notes            String?
├── noShowCount      Int           @default(0)
├── createdAt        DateTime      @default(now())
└── updatedAt        DateTime      @updatedAt
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | String (cuid) | Primary key |
| `studentId` | String (FK → User) | The student who made the booking |
| `facultyId` | String (FK → Faculty) | The faculty member being booked |
| `startTime` | DateTime (UTC) | Booking start time, always stored in UTC |
| `endTime` | DateTime (UTC) | Booking end time, always stored in UTC |
| `status` | Enum | See §2 below |
| `idempotencyKey` | String (unique, optional) | Prevents duplicate submissions from same client |
| `title` | String (optional) | Human-readable booking purpose |
| `notes` | String (optional) | Additional context from student |
| `noShowCount` | Int | Running count of no-shows for this student (denormalised for fast lookup) |
| `createdAt` | DateTime | Record creation timestamp |
| `updatedAt` | DateTime | Last modification timestamp |

---

## 2. Booking Status Enum

```
enum BookingStatus {
  CONFIRMED   // Booking created and confirmed
  CANCELLED   // Cancelled by student or faculty
  COMPLETED   // Meeting took place
  NO_SHOW     // Student did not attend
}
```

| Status | Meaning |
| :--- | :--- |
| `CONFIRMED` | Booking is active and the slot is reserved |
| `CANCELLED` | Booking was released or cancelled; slot is free again |
| `COMPLETED` | The appointment took place |
| `NO_SHOW` | The student did not attend; counted toward no-show history |

---

## 3. Relationships

```
User ──< Booking (as student)
Faculty ──< Booking
Faculty ──< FacultySchedule
User ──── Faculty (1:1 for faculty accounts)
```

- A **User** (student) can have many **Bookings**.
- A **Faculty** can have many **Bookings** (from different students).
- A **Faculty** has many **FacultySchedule** rows (one per working day).
- Each **Booking** belongs to exactly one student and one faculty.

---

## 4. Concurrency Protection — Proposed Constraint

### Current Gap (Observed)
The reference implementation has **no database-level constraint** preventing two booking records from overlapping in `[startTime, endTime)` for the same faculty member. Two concurrent inserts can both succeed, resulting in a double-booked slot.

### Proposed Solution
Add a database-level constraint to enforce non-overlapping bookings per faculty:

**Option A — PostgreSQL GiST Exclusion Constraint** (preferred):
```sql
ALTER TABLE "Booking"
ADD CONSTRAINT booking_no_overlap
EXCLUDE USING gist (
    "facultyId" WITH =,
    tsrange("startTime"::timestamp, "endTime"::timestamp) WITH &&
)
WHERE (status = 'CONFIRMED');
```

This ensures that two `CONFIRMED` bookings for the same `facultyId` cannot have overlapping time ranges. A concurrent `INSERT` that would violate this constraint fails immediately at the database level, regardless of application-layer timing.

**Option B — Composite Unique / Lock Table**: A `SlotLock` table with a `(facultyId, slotKey)` unique constraint used with `SELECT ... FOR UPDATE`.

> The specific implementation will be determined during the development phase. The requirement (CON-1 in PRD) holds regardless of mechanism.

---

## 5. No-Show Count Design

- `Booking.noShowCount` is a **denormalised** field on the `Booking` record for fast lookup.
- It is updated when a booking is marked `NO_SHOW`.
- The no-show reminder logic reads this field directly: `if (student.noShowCount >= 2)`.
- Alternatively, no-show count can be computed from `Booking` history at query time; the implementation approach will be decided during development.
