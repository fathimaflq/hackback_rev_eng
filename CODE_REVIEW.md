# HACKBACK code review · DBG-307 · Smart Slot Booking
- Reviewed at: 2026-10-06T08:56:50Z (2026-10-06T14:26:50+05:30 IST)
- Judged commit: 4eeb5c48294bb3b53121f35bf20453448389e474 (2026-10-06T13:27:18+05:30) · the last commit before the code freeze
- Reviewer: AI agent run by a HACKBACK judge

### DBG-307 · Smart Slot Booking
Commit: 4eeb5c48294bb3b53121f35bf20453448389e474 · 2026-10-06T13:27:18+05:30 · Clean-room: OK / see flags

| Section | Score | Why (path:line) |
|---|---|---|
| A. Core flow | 30/30 | Host availability stored with IANA timezone (database/schema.sql:25, database/seed.sql:20); slot engine with Luxon converts to booker timezone and enforces 15m buffer (backend/src/engine.js:4-66); day-off overrides supported (backend/src/engine.js:27-37); booking with GiST atomic guard and cancellation with waitlist promotion work end-to-end (backend/src/booking.js:7-138). |
| B. Killer Tests | 30/30 | All 3 killer tests implemented on server and passing via automated test suite backend/tests/killer.js:6-14 and backend/src/demo.js:1-45. |
| C. Two improvements | 20/20 | 1) Atomic concurrency double-booking prevention via PostgreSQL GiST exclusion constraint (database/schema.sql:51-54, backend/src/booking.js:29-47, backend/src/server.js:106-120). 2) FIFO Waiting Queue with transaction-safe auto-promotion on cancellation (backend/src/booking.js:52-142, backend/src/server.js:67-69, frontend/index.html:1408-1486). |
| D. Built from their docs | 10/10 | Matches PRD acceptance criteria CON-1..CON-4 and NS-2..NS-5, API endpoints in docs/API.md, and database schema in docs/DATA_MODEL.md with Option A exclusion constraint. |
| E. Engineering | 10/10 | Strict input validation on all routes (backend/src/server.js:33-35, backend/src/booking.js:8-23); student identity checks on mutations (backend/src/booking.js:63, 204); async error handling wrapper (backend/src/server.js:18-20); UTC timestamps throughout (database/schema.sql:42-44); no committed secrets (.env.example only). |
| Total | 100/100 | |

Killer Tests:
1. READY · 10/10 · Host Asia/Kolkata (11:00 AM IST) converts accurately to Booker America/Los_Angeles (10:30 PM PDT previous day) and UTC instant 05:30Z via Luxon (backend/src/engine.js:61-66). Verified passing via npm run test:killer (backend/tests/killer.js:8, backend/src/demo.js:11-21).
2. READY · 10/10 · 15-minute buffer is computed on the server (backend/src/engine.js:4, 52-59) and enforced in PostgreSQL using tstzrange("startTime", "bufferEnd") with GiST exclusion constraint (database/schema.sql:51-54, backend/src/booking.js:25, 45). Probes at 10:30 and 10:40 return 409 Conflict, 10:45 returns 201 Created. Verified passing via npm run test:killer (backend/tests/killer.js:8, backend/src/demo.js:23-33).
3. READY · 10/10 · Concurrent bookings for the same slot run simultaneously with Promise.all. Exactly one receives 201 Created and the competing request is blocked by PostgreSQL GiST exclusion constraint returning 409 Conflict with exactly 1 row in database (database/schema.sql:51-54, backend/src/booking.js:29-47). Verified passing via npm run test:killer (backend/tests/killer.js:8, backend/src/demo.js:35-43).

Improvements:
1. Atomic Booking Guard (PostgreSQL GiST Range Exclusion) · 10/10 · Promised in docs/GAPS.md:46-56 and docs/GAPS.md:143. Enforces database-level non-overlapping booking ranges using EXCLUDE USING gist ("facultyId" WITH =, tstzrange("startTime", "bufferEnd") WITH &&) WHERE (status = 'CONFIRMED') (database/schema.sql:51-54, backend/src/booking.js:29-47). Wired into live race testing endpoint POST /api/demo/race (backend/src/server.js:106-120).
2. FIFO Waiting Queue with Auto-Promotion on Cancellation · 10/10 · Promised in SUBMISSION.md:21-25 and PRD feature requirements. Backed by PostgreSQL Waitlist table (backend/src/booking.js:144-197), tracks queue positions WL1/WL2, and executes atomic auto-promotion in a database transaction when a booking is released (backend/src/booking.js:52-142). Wired into POST /api/waitlist, POST /api/waitlist/:id/leave, GET /api/waitlist/my (backend/src/server.js:67-69) and UI (frontend/index.html:1408-1486).

Flags:
- Pushes after 6 Oct 1:30 pm IST: Two documentation commits (19fd475 at 13:30:30 IST and f7d710c at 13:31:08 IST) were pushed shortly after the 1:30 pm IST freeze to enhance README.md and SUBMISSION.md. The last source code commit was 4eeb5c4 at 13:27:18 IST (before the freeze).
- Clean-room: OK. No code copied from Cal.com; all code is clean handwritten Node.js/Express + PostgreSQL. Docs committed on 5 Oct before source code implementation on 6 Oct.
- Secrets: None. Only .env.example committed.
- Fake / Stubs: None. All endpoints query live database and real slot engine.

3 questions for the judges to ask this team in their Defence:
1. In backend/src/booking.js:31-35, you perform an early SELECT 1 check before the INSERT and note in comments that under READ COMMITTED two concurrent requests can both pass this check. Can you explain how the PostgreSQL GiST exclusion constraint (booking_no_overlap) acts as the authoritative concurrency guard and what SQLSTATE error code it returns on collision?
2. When an active reservation is cancelled via POST /api/bookings/:id/release (backend/src/booking.js:52-142), how does your PostgreSQL transaction guarantee that the WL1 waitlisted student is atomically promoted to CONFIRMED without creating a race window where an outsider could book the released slot?
3. In backend/src/engine.js:52-59, how does your slot engine compute the transition buffer before vs. after a booking to ensure that consecutive sessions never overlap even when scheduled across distinct host and booker timezones?

SCORE core=30 kt=30 imp=20 docs=10 eng=10 total=100
