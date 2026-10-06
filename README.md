# Smart Slot Booking

## Overview
Faculty–student appointment booking with three guarantees, built from `docs/`:
1. **Concurrency-safe booking**: exactly one of two simultaneous requests wins (`201`), the other gets `409`.
2. **Real timezone handling**: slots are stored in UTC and converted on the server for host and booker.
3. **Buffer enforcement**: a booking plus a 15-minute buffer is unavailable, enforced in the backend and the database.

## Features
- Availability engine (source of truth): working hours + existing bookings + duration + buffer, all in UTC.
- Booking service with idempotency key, release (`/release`) and history.
- Dark scheduling dashboard (`/`) and a killer-test panel (`/demo.html`).
- Suggestions: nearest free slots from real availability; they only pre-select a slot, never book.
- Rule-based no-show reminder (`noShowCount >= 2` → early reminder + "Release my slot").

## Architecture
```
Browser UI → Express API → Booking Service → Atomic guard (PostgreSQL EXCLUDE constraint) → DB
                    └→ Availability Engine → Suggestions
```
Concurrency guard: `EXCLUDE USING gist ("facultyId" WITH =, tstzrange("startTime","bufferEnd") WITH &&) WHERE (status='CONFIRMED')`
(DATA_MODEL.md Option A). The pre-insert check in `booking.js` is only a fast path; the constraint decides.

## Tech Stack
Node.js 20+, Express, PostgreSQL 16 (`btree_gist`), `pg`, `luxon` (IANA timezones), vanilla HTML/JS frontend.

## Local Setup
```bash
docker compose up -d                 # PostgreSQL (or use any local Postgres 16)
cd backend && npm install
cp ../.env.example .env
```

## Environment Variables
See `.env.example`: `PORT`, `DATABASE_URL`, `BUFFER_MINUTES`, optional `LLM_API_KEY` (unused; suggestions are deterministic).

## Database Setup
```bash
cd backend && npm run db:init        # applies database/schema.sql + seed.sql (resets data)
```

## Running the Application
```bash
cd backend && npm start
```
- Main UI: http://localhost:3000
- Killer test panel: http://localhost:3000/demo.html

## API
Follows `docs/API.md` for `GET /api/slots`, `POST /api/bookings`, `POST /api/bookings/:id/release`, `GET /api/bookings/history`.
Additions: `bookerTz` and `step` query params on `/api/slots`, `GET /api/suggestions`, `GET /api/reminders`, `GET /api/faculty/:id`, `POST /api/demo/{timezone|buffer|concurrent}`.
`POST /api/smart-booking` (natural language) is **not implemented** (out of scope for this prototype).
The student is read from the `x-user-id` header (default `stu_you`); there is no authentication.

## Killer Tests
Open http://localhost:3000/demo.html and press each button, or run all three from a terminal while the server is up:
```bash
cd backend && npm run test:killer
```
### 1. Timezone Test
Host `Asia/Kolkata`, booker `America/Los_Angeles`. 11:00 AM IST on 14 Oct 2026 must be stored as `05:30Z` and shown as `10:30 PM PDT` on Tue Oct 13.
### 2. Buffer Test
Booking 10:00–10:30 + 15 min buffer. `10:30` → 409, `10:40` → 409, `10:45` → 201 (engine status and real POST results are shown).
### 3. Concurrent Booking Test
Two real HTTP requests (Student A, Student B) are sent with `Promise.all` for the same slot.
Expected: `201 Created`, `409 Conflict`, and 1 confirmed row in `Booking`.

## Demo
1. `docker compose up -d`, `npm run db:init`, `npm start` (in `backend/`).
2. Open `/` → pick Wed 14 → select 11:00 → see host/local/UTC → Confirm. Switch the booker timezone in the header.
3. Open `/demo.html` → run the three tests.
