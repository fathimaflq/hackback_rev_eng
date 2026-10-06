INSERT INTO "User"(id,name,email,role,timezone) VALUES
 ('usr_rao','Prof. K. Rao','rao@example.edu','FACULTY','Asia/Kolkata'),
 ('usr_sharma','Dr. A. Sharma','sharma@example.edu','FACULTY','Asia/Kolkata'),
 ('usr_test','Test Faculty','test@example.edu','FACULTY','Asia/Kolkata'),
 ('stu_you','You (demo student)','you@example.edu','STUDENT','America/Los_Angeles'),
 ('student_A','Student A','a@example.edu','STUDENT','America/Los_Angeles'),
 ('student_B','Student B','b@example.edu','STUDENT','America/Los_Angeles'),
 ('stu_seed','Seed Student','seed@example.edu','STUDENT','Asia/Kolkata');

INSERT INTO "Faculty"(id,"userId",department,location) VALUES
 ('fac_rao','usr_rao','Quantum Optics & Photonic Systems','Quantum Optics Lab · Station 04, Room C-204'),
 ('fac_sharma','usr_sharma','Machine Learning & AI Systems','AI Research Wing · Room B-112'),
 ('fac_test','usr_test','Killer-test sandbox (cleared on every test run)','Test room');

-- Working hours Mon–Fri for all three faculty (dayOfWeek 1=Mon … 5=Fri)
INSERT INTO "FacultySchedule"("facultyId","dayOfWeek","startTime","endTime",timezone)
 SELECT f, d, '08:30', '17:00', 'Asia/Kolkata'
 FROM unnest(ARRAY['fac_rao','fac_sharma','fac_test']) f, generate_series(1,5) d;

-- ── Date overrides for fac_rao ──────────────────────────────────────────────
-- Day-off: the Thursday of the current week (dynamic)
INSERT INTO "FacultyDateOverride"("facultyId",date,type,reason)
 SELECT 'fac_rao',
        (date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata') + interval '3 days')::date,
        'DAY_OFF',
        'Faculty conference – unavailable all day';

-- Custom hours: the Friday of the current week (10:00–14:00 only)
INSERT INTO "FacultyDateOverride"("facultyId",date,type,"startTime","endTime")
 SELECT 'fac_rao',
        (date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata') + interval '4 days')::date,
        'CUSTOM_HOURS',
        '10:00',
        '14:00';

-- Existing bookings on Wed 14 Oct 2026 (IST 10:00-10:30 and 14:30-15:00)
INSERT INTO "Booking"(id,"studentId","facultyId","startTime","endTime","bufferEnd")
 SELECT 'seed_1','stu_seed','fac_rao', t, t+interval '30 minutes', t+interval '45 minutes'
 FROM (SELECT timestamptz '2026-10-14 10:00+05:30' t) x;
INSERT INTO "Booking"(id,"studentId","facultyId","startTime","endTime","bufferEnd")
 SELECT 'seed_2','stu_seed','fac_rao', t, t+interval '30 minutes', t+interval '45 minutes'
 FROM (SELECT timestamptz '2026-10-14 14:30+05:30' t) x;

-- Two past no-shows for the demo student, and a booking tomorrow 11:00 IST (for the reminder card)
INSERT INTO "Booking"(id,"studentId","facultyId","startTime","endTime","bufferEnd",status) VALUES
 ('ns_1','stu_you','fac_rao','2026-09-15 09:00+05:30','2026-09-15 09:30+05:30','2026-09-15 09:45+05:30','NO_SHOW'),
 ('ns_2','stu_you','fac_rao','2026-09-22 14:00+05:30','2026-09-22 14:30+05:30','2026-09-22 14:45+05:30','NO_SHOW');
INSERT INTO "Booking"(id,"studentId","facultyId","startTime","endTime","bufferEnd")
 SELECT 'up_1','stu_you','fac_rao', t, t+interval '30 minutes', t+interval '45 minutes'
 FROM (SELECT ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day 11 hours') AT TIME ZONE 'Asia/Kolkata') t) x;
