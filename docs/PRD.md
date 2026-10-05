# Product Requirements Document — Smart Slot Booking
## 1. Problem

Faculty–student appointment scheduling at educational institutions is commonly managed through informal channels (WhatsApp, email, verbal requests), leading to:

- **Double bookings**: Two students grab the same faculty slot, causing confusion.
- **No-shows**: Students book slots but fail to attend, wasting faculty time.
- **Friction**: Students must manually search for available slots, often across multiple communication channels.

A structured booking system exists in principle, but without concurrency protection or smart features, the core booking operation remains vulnerable to race conditions and does not reduce no-show rates.

---

## 2. Target Users

| User Type | Description |
| :--- | :--- |
| **Students** | Book appointment slots with faculty members. |
| **Faculty** | Own and manage their availability schedules. |
| **Administrators** | (Out of scope for this phase) Manage users and system configuration. |

---

## 3. User Needs

### Student Needs
- Find faculty availability quickly without manual back-and-forth.
- Book a slot and receive a guaranteed confirmation (no surprise double-booking).
- Use natural language to describe what they need rather than navigating complex slot grids.
- Be reminded of upcoming appointments, especially if they have a history of no-shows.

### Faculty Needs
- Trust that confirmed bookings are genuinely exclusive — no double-booked slots.
- Recover wasted time when students release unused slots.
- Minimal overhead in managing their booking schedule.

---

## 4. Product Goal

> Deliver a lightweight, reliable, and smart faculty appointment booking system where:
> 1. Confirmed bookings are guaranteed to be exclusive.
> 2. Students can describe appointments in natural language.
> 3. Repeat no-show students receive earlier reminders and a slot-release option.

---

## 5. Core User Flows

### Standard Booking Flow

```
Student
  → Browse / search for faculty
  → View available slots
  → Select a slot
  → Confirm booking
  → Receive confirmation (guaranteed exclusive)
```

### Natural-Language Booking Flow

```
Student types: "I need 30 mins with Prof. Rao sometime Thursday afternoon"
  → NL Parser extracts: { faculty: "Prof. Rao", duration: 30, day: "Thursday", timeRange: "afternoon" }
  → Availability Engine queries slots matching those filters
  → Available slots displayed to student
  → Student selects slot
  → Concurrency-safe booking proceeds normally
```

> **Important**: The NL parser only converts text into structured filters. It does **not** determine availability. The availability engine remains the single source of truth.

### No-Show Reminder Flow

```
System checks booking history before sending reminders
  → Count previous no-shows for the student
  → If no-shows >= 2:
      → Send reminder earlier than standard schedule
      → Show "Release My Slot" button in reminder
  → Student releases slot
      → Slot becomes available for other students to book
```

> **Important**: This logic is purely **rule-based** (no-show count threshold). No machine learning is involved.

---

## 6. Core Features

### Feature 1 — Concurrency-Safe Booking

Prevent two students from successfully booking the same faculty slot simultaneously.

**Key requirement**: The booking operation must be atomic at the database level. Application-layer checks alone are not sufficient.

### Feature 2 — Natural-Language Booking

Allow students to describe their booking needs in plain text. The system parses the input into structured filters and passes those to the standard availability engine.

**Key requirement**: The AI/parser component is limited to parsing only. Slot selection and availability determination remain deterministic.

### Feature 3 — Smart No-Show Reminders

Apply a rule-based escalation to students with two or more previous no-shows: earlier reminder delivery and a slot-release option.

**Key requirement**: Rule-based only. No ML. The threshold is `no_show_count >= 2`.

---

## 7. Functional Requirements

### Concurrency-Safe Booking

| ID | Requirement |
| :--- | :--- |
| CON-1 | Exactly one booking MUST succeed when two simultaneous requests target the same slot at capacity 1. |
| CON-2 | The availability check and database INSERT must be atomic — no concurrent request may observe the slot as free and insert after another has already taken it. |
| CON-3 | The losing concurrent request MUST receive a clear conflict error response. |
| CON-4 | Client retries with the same `idempotencyKey` MUST return the original booking without creating a duplicate. |

### Natural-Language Booking

| ID | Requirement |
| :--- | :--- |
| NL-1 | The system MUST accept a free-text booking request from a student. |
| NL-2 | The parser MUST extract at minimum: faculty name/identifier, duration, date/day, and time range (where provided). |
| NL-3 | Parsed filters MUST be passed to the standard availability engine, not used to directly confirm a booking. |
| NL-4 | The student MUST confirm the final slot selection explicitly before a booking is created. |
| NL-5 | If the parser cannot extract a required field, it MUST prompt the student for clarification. |

### Smart No-Show Reminders

| ID | Requirement |
| :--- | :--- |
| NS-1 | The system MUST track whether a student attended each confirmed booking. |
| NS-2 | If a student has `no_show_count >= 2`, they MUST receive their reminder earlier than the standard reminder schedule. |
| NS-3 | The reminder for such students MUST include a "Release My Slot" action. |
| NS-4 | When a slot is released, its status MUST update to make it available for other students. |
| NS-5 | The no-show count MUST be calculated from historical booking records only — no ML or predictive modelling. |

---

## 8. Non-Functional Requirements

| ID | Requirement |
| :--- | :--- |
| NFR-1 | The concurrency guarantee (CON-1) must hold under simultaneous competing booking requests. |
| NFR-2 | Natural-language parsing latency should not introduce noticeable delay over standard booking. |
| NFR-3 | The system must be testable with automated unit and integration tests for each of the three features. |
| NFR-4 | All API endpoints must return appropriate HTTP status codes for both success and error cases. |
