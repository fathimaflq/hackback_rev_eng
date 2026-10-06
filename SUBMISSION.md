# Project Submission: Smart Slot Booking

## Executive Summary
Smart Slot Booking is an appointment scheduling platform designed to eliminate the most common failure points in calendar systems:
1. **Double-bookings from concurrent requests** (prevented via PostgreSQL GiST exclusion constraints).
2. **Timezone errors across global users** (handled with UTC instants and Luxon IANA conversions).
3. **Back-to-back fatigue** (enforced with a mandatory 15-minute buffer).
4. **Wasted unused slots** (solved with a FIFO waiting queue that auto-promotes waitlisted students when bookings are cancelled).
5. **Complex filter menus** (simplified with a zero-hallucination natural-language parser).

---

## What Was Implemented

### 1. Concurrency Safety (CON-1..CON-4)
- **Database-Level Guard:** Protected by PostgreSQL's `EXCLUDE USING gist (host_id WITH =, tstzrange("startTime", "bufferEnd") WITH &&)`.
- **Zero Double-Bookings:** When two students book the exact same slot simultaneously, the database guarantees exactly one succeeds (`201 Created`) and the second is immediately rejected with `409 Conflict`.
- **Idempotency:** Supports `Idempotency-Key` headers to safely retry without duplicate bookings.

### 2. Natural-Language Booking Assistant (NL-1..NL-5)
- Supports plain English prompts (e.g., *"I need 30 mins with Prof. Rao sometime Thursday afternoon"*).
- Extracts:
  - **Faculty:** Matched by name (e.g., Prof. Rao, Dr. Sharma).
  - **Duration:** 15m, 30m, 45m, 60m.
  - **Date Ranges:** Relative days (*today*, *tomorrow*, *Thursday*, *next week*).
  - **Time Periods:** Morning, afternoon, evening.
- **Availability Guarantee:** The AI only parses the student's intent into structured filters; slot availability is strictly determined by the deterministic availability engine.

### 3. FIFO Waiting Queue with Auto-Promotion
- If a slot is booked, students can join the queue (`WL1`, `WL2`, etc.).
- When a confirmed student cancels or releases their reservation, a PostgreSQL transaction automatically marks the existing booking cancelled and promotes the first student in the queue (`WL1`) to `CONFIRMED`.

### 4. Timezone & Buffer Precision
- **UTC Instants:** All database records use `TIMESTAMPTZ`. Times are translated on the fly for both the host's timezone (`Asia/Kolkata`) and the student's timezone (`America/Los_Angeles`).
- **15-Minute Buffers:** Slots within 15 minutes of a scheduled session are locked to give faculty cool-down time.

### 5. Frontend & Live Lab Experience
- **Interactive Views:**
  - **Slot Booking:** Visual weekly schedule picker with dynamic timezone conversion.
  - **AI Assistant:** Natural-language search with quick prompt chips.
  - **My Bookings:** Real-time view of confirmed bookings, queue positions, and cancellation actions.
  - **Concurrency & Queue Lab:** Interactive testbench to fire simultaneous collisions and watch auto-promotion live.
- **Sticky Top Bar:** Fixed account switcher (`Student A`, `Student B`, `You / Demo Student`) and timezone selector that stays accessible while scrolling.
- **Calendar Sync:** Export bookings to Google Calendar or Apple Calendar (`.ics`).

---

## Verification & Results

All three core tests pass consistently against PostgreSQL:

```bash
cd backend && npm run test:killer
```

| Test Case | Scenario | Expected Result | Actual Result |
| :--- | :--- | :--- | :--- |
| **1. Timezone Correctness** | Host `11:00 AM IST` viewed in Los Angeles | Converts to `10:30 PM PDT (previous day)`, stored as `05:30 UTC` | PASS |
| **2. Buffer Enforcement** | Existing 10:00–10:30 booking with 15m buffer | 10:30 -> 409, 10:40 -> 409, 10:45 -> 201 | PASS |
| **3. Concurrent Booking** | Student A and Student B book simultaneously | Exactly one 201 Created, one 409 Conflict; 1 row in DB | PASS |

---

## How to Run

```bash
# 1. Start PostgreSQL (Docker or local)
docker compose up -d

# 2. Setup database
cd backend
npm install
npm run db:init

# 3. Start the application
npm start
```
- Open `http://localhost:3000` to interact with the web app.
- Open `http://localhost:3000/demo.html` for the standalone killer test panel.
