# Submission: Smart Slot Booking

## What was built
A working local prototype (Express + PostgreSQL + vanilla frontend) prioritising the three killer tests: timezone conversion, buffer enforcement, and concurrency-safe booking. Docs are in `docs/` and are the source of truth.

## Implemented from the docs
- PRD CON-1..CON-4 (exclusive booking, atomic guard, clear 409, idempotency key).
- PRD NS-2..NS-5 (rule-based reminder with `no_show_count >= 2`, release endpoint; count computed from `Booking` history).
- Architecture: Availability Service as source of truth; suggestions never create bookings.
- DATA_MODEL: User, Faculty, FacultySchedule, Booking, `BookingStatus`, GiST exclusion constraint (Option A).

## Not implemented
- `POST /api/smart-booking` and the natural-language parser (NL-1..NL-5). Suggestions are a deterministic ranking, not an LLM.
- Authentication, admin features, real reminder delivery (email/push), marking bookings `NO_SHOW` automatically.
- Automated unit tests beyond the killer-test script.

## Small implementation choices (not specified in the docs)
- `Booking.bufferEnd` (= `endTime` + buffer) is stored so the exclusion constraint can include the buffer; `tstzrange` (timestamptz) is used instead of `tsrange` so UTC instants compare correctly.
- A slot is allowed only if `[start, end+buffer)` does not overlap any existing `[start, end+buffer)`. So a slot ending right before an existing booking (e.g. 09:30–10:00 before a 10:00 booking) is shown as Buffer.
- Added `User.timezone`, `Faculty.location`; working hours Mon–Fri 08:30–17:00 in the host timezone.
- Student identity via `x-user-id` header; killer tests use sandbox faculty `fac_test`.

## How it was verified (run against PostgreSQL 16)
- `npm run test:killer`: timezone PASS, buffer PASS (409, 409, 201), concurrent PASS (201 + 409, 1 confirmed row); concurrency test repeated 9 times with the same result.
- A raw SQL insert of an overlapping booking was rejected by `booking_no_overlap`.
- API checked with curl: slots, suggestions, reminders, idempotent retry (200), other student on same slot (409), release.
- The frontend files are served (HTTP 200) but were not exercised in a real browser by the author of this file; open `/` and `/demo.html` to confirm visually.
