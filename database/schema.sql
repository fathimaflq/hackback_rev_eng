-- Smart Slot Booking schema (follows docs/DATA_MODEL.md). Re-running resets all data.
DROP TABLE IF EXISTS "Booking","FacultyDateOverride","FacultySchedule","Faculty","User" CASCADE;
DROP TYPE IF EXISTS "BookingStatus","Role","OverrideType";
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE "Role" AS ENUM ('STUDENT','FACULTY','ADMIN');
CREATE TYPE "BookingStatus" AS ENUM ('CONFIRMED','CANCELLED','COMPLETED','NO_SHOW');
CREATE TYPE "OverrideType" AS ENUM ('DAY_OFF','CUSTOM_HOURS');

CREATE TABLE "User" (
  id text PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL,
  role "Role" NOT NULL DEFAULT 'STUDENT',
  timezone text NOT NULL DEFAULT 'UTC',            -- addition: booker's IANA timezone
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());

CREATE TABLE "Faculty" (
  id text PRIMARY KEY, "userId" text UNIQUE NOT NULL REFERENCES "User"(id),
  department text, location text,                  -- addition: location shown in UI
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());

CREATE TABLE "FacultySchedule" (
  id serial PRIMARY KEY, "facultyId" text NOT NULL REFERENCES "Faculty"(id),
  "dayOfWeek" int NOT NULL CHECK ("dayOfWeek" BETWEEN 0 AND 6),   -- 0 = Sunday
  "startTime" text NOT NULL, "endTime" text NOT NULL,             -- HH:MM in the schedule timezone
  timezone text NOT NULL);

-- Faculty-specific date overrides: day-offs and custom working hours.
CREATE TABLE "FacultyDateOverride" (
  id serial PRIMARY KEY,
  "facultyId" text NOT NULL REFERENCES "Faculty"(id),
  date date NOT NULL,                              -- YYYY-MM-DD in faculty's local timezone
  type "OverrideType" NOT NULL,
  reason text,                                     -- optional human-readable note shown in UI
  "startTime" text,                                -- HH:MM, only for CUSTOM_HOURS
  "endTime"   text,                                -- HH:MM, only for CUSTOM_HOURS
  UNIQUE ("facultyId", date));

CREATE TABLE "Booking" (
  id text PRIMARY KEY,
  "studentId" text NOT NULL REFERENCES "User"(id),
  "facultyId" text NOT NULL REFERENCES "Faculty"(id),
  "startTime" timestamptz NOT NULL,                 -- always UTC instants
  "endTime"   timestamptz NOT NULL,
  "bufferEnd" timestamptz NOT NULL,                 -- addition: endTime + buffer, set by the booking service
  status "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
  "idempotencyKey" text UNIQUE, title text, notes text,
  "noShowCount" int NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("endTime" > "startTime"), CHECK ("bufferEnd" >= "endTime"));

-- CON-1/CON-2: the database itself refuses overlapping confirmed bookings (booking + buffer) per faculty.
ALTER TABLE "Booking" ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist ("facultyId" WITH =, tstzrange("startTime","bufferEnd") WITH &&)
  WHERE (status = 'CONFIRMED');
