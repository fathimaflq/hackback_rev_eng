# Smart Slot Booking

A concurrency-safe, timezone-aware appointment booking system for universities and faculty office hours. Built with Node.js, Express, PostgreSQL, and Vanilla JavaScript.

---

## Key Highlights

1. **Concurrency Safe (No Double-Bookings)**
   - Uses PostgreSQL's atomic GiST exclusion constraint (`EXCLUDE USING gist`).
   - If two students book the exact same slot at the exact same millisecond, exactly one gets `201 Created` and the other gets `409 Conflict`.

2. **Natural-Language AI Assistant**
   - Type plain English requests like: *"I need 30 mins with Prof. Rao sometime Thursday afternoon"*.
   - Automatically extracts faculty, date range, duration, and time of day, returning real free slots.
   - Zero hallucinations: availability is strictly verified by the backend slot engine.

3. **FIFO Waiting Queue (WL1 Auto-Promotion)**
   - When a slot is taken, students can join the waiting queue (`WL1`, `WL2`...).
   - When the confirmed student cancels or releases their reservation, the queue automatically promotes `WL1` to `CONFIRMED` in a database transaction.

4. **Real Dual-Timezone Handling**
   - All slots are stored in UTC (`TIMESTAMPTZ`).
   - Shows host time (e.g. `11:00 AM IST`) and student time (e.g. `10:30 PM PDT, prev day`) accurately without timezone bugs.

5. **15-Minute Transition Buffer**
   - Automatically enforces a mandatory 15-minute cool-down buffer after every meeting to prevent back-to-back overlaps.

6. **1-Click Calendar Sync**
   - Add confirmed bookings directly to Google Calendar or download Apple Calendar (`.ics`) with full meeting details and dual timezones.

---

## Quick Start (Run Locally)

### 1. Prerequisites
- Node.js (v18+)
- PostgreSQL running locally or via Docker

### 2. Setup Database
```bash
# Option A: With Docker
docker compose up -d

# Option B: With local PostgreSQL
createdb ssb
psql -d ssb -f database/schema.sql
psql -d ssb -f database/seed.sql
```

### 3. Install Dependencies & Configure Environment
```bash
cd backend
npm install
cp ../.env.example .env
```
*(Make sure `DATABASE_URL` in `backend/.env` points to your PostgreSQL database).*

### 4. Seed the Database
```bash
npm run db:init
```

### 5. Start the Server
```bash
npm start
```
Open **http://localhost:3000** in your browser.

---

## Testing the 3 Killer Tests

Run the automated test suite directly in your terminal:
```bash
npm run test:killer
```

### What gets verified:
- **Test 1: Timezone Correctness** — Verifies `11:00 AM IST` correctly maps to `10:30 PM PDT` (previous day) and `05:30 UTC`.
- **Test 2: Buffer Enforcement** — Verifies a booking at 10:00–10:30 with 15m buffer blocks `10:30` (409) and `10:40` (409), and opens at `10:45` (201).
- **Test 3: Concurrency Race** — Fires two simultaneous requests from Student A and Student B at the exact same millisecond. Exactly 1 passes (201) and 1 is rejected by PostgreSQL (409).

You can also test this interactively in the web UI under the **"Concurrency & Queue Lab"** tab.

---

## Project Structure

```
ssb/
├── backend/
│   ├── src/
│   │   ├── booking.js        # Atomic booking service & queue auto-promotion
│   │   ├── engine.js         # Deterministic slot availability & buffer engine
│   │   ├── nlp.js            # Natural-language query parser
│   │   ├── server.js         # Express REST API routes
│   │   ├── db.js             # PostgreSQL connection pool
│   │   └── demo.js           # Live test endpoints
│   ├── scripts/init-db.js    # Database migration & seed runner
│   └── tests/killer.js       # Automated test suite
├── database/
│   ├── schema.sql            # PostgreSQL tables & GiST exclusion constraints
│   └── seed.sql              # Seed faculty, schedules, and test accounts
├── frontend/
│   ├── index.html            # Main UI (Booking, AI Assistant, My Bookings, Lab)
│   ├── style.css             # Dark theme styling & responsive layout
│   └── demo.html             # Standalone killer test panel
├── docs/                     # Architectural specs and PRD documentation
├── docker-compose.yml        # PostgreSQL container setup
└── README.md
```
