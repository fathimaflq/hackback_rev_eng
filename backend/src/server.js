require('dotenv').config();
const express = require('express');
const path = require('path');
const { DateTime } = require('luxon');
const pool = require('./db');
const engine = require('./engine');
const booking = require('./booking');
const demo = require('./demo');
const nlp = require('./nlp');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../frontend')));
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Internal server error' }); });
const user = req => req.get('x-user-id') || 'stu_you';   // no auth in the prototype (see SUBMISSION.md)
const send = (res, r) => res.status(r.status).json(r.body);
const validTz = z => { try { Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } };

// List all faculty (for the faculty picker in the UI)
app.get('/api/faculty', wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT f.id, u.name, f.department, f.location,
            (SELECT timezone FROM "FacultySchedule" WHERE "facultyId"=f.id LIMIT 1) AS timezone
     FROM "Faculty" f JOIN "User" u ON u.id=f."userId"
     WHERE f.id != 'fac_test'
     ORDER BY u.name`);
  res.json({ faculty: r.rows });
}));

app.get('/api/faculty/:id', wrap(async (req, res) => {
  const r = await pool.query('SELECT f.id, u.name, f.department, f.location FROM "Faculty" f JOIN "User" u ON u.id=f."userId" WHERE f.id=$1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Faculty not found' });
  res.json({ ...r.rows[0], timezone: await engine.hostTz(req.params.id) });
}));

// GET /api/overrides/:facultyId/:date — returns the date override for a given date (or null)
app.get('/api/overrides/:facultyId/:date', wrap(async (req, res) => {
  const override = await engine.getOverride(req.params.facultyId, req.params.date);
  res.json({ override: override || null });
}));// List all users (students and faculty) for the user switcher in the UI
app.get('/api/users', wrap(async (req, res) => {
  const r = await pool.query('SELECT id, name, email, role, timezone FROM "User" ORDER BY role DESC, id ASC');
  res.json({ users: r.rows });
}));

// GET /api/slots?facultyId&date&duration[&step&bookerTz]
// Now also returns dayOff + reason when a DAY_OFF override exists, plus waitlist queue metadata.
app.get('/api/slots', wrap(async (req, res) => {
  const { facultyId, date } = req.query, duration = Number(req.query.duration), step = Number(req.query.step || duration);
  const bookerTz = req.query.bookerTz || 'UTC';
  if (!facultyId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !(duration > 0) || !(step > 0) || !validTz(bookerTz))
    return res.status(400).json({ error: 'facultyId, date (YYYY-MM-DD), duration required; bookerTz must be an IANA zone' });
  const r = await engine.getSlots({ facultyId, date, duration, step, bookerTz, studentId: user(req) });
  if (!r) return res.status(404).json({ error: 'Faculty not found' });
  res.json({
    facultyId, date, duration, hostTimezone: r.hostTz, bookerTimezone: bookerTz,
    bufferMinutes: engine.BUF, dayOff: r.dayOff || false, reason: r.reason || null,
    customHours: r.customHours || false,
    availableSlots: r.slots.filter(s => s.status === 'available'), slots: r.slots
  });
}));

// AI-assist: deterministic ranking over real availability (nearest free slots to the user's pick). Never books.
app.get('/api/suggestions', wrap(async (req, res) => {
  const { facultyId, date, near, bookerTz = 'UTC' } = req.query;
  const r = await engine.getSlots({ facultyId, date, duration: 30, step: 15, bookerTz, studentId: user(req) });
  if (!r) return res.status(404).json({ error: 'Faculty not found' });
  const ref = near ? Date.parse(near) : 0;
  const free = r.slots.filter(s => s.status === 'available' && s.startTime !== near);
  free.sort((a, b) => Math.abs(Date.parse(a.startTime) - ref) - Math.abs(Date.parse(b.startTime) - ref));
  res.json({ suggestions: free.slice(0, 3).sort((a, b) => a.startTime.localeCompare(b.startTime)) });
}));

// Natural-language booking (turns student queries into structured filters -> queries real slot engine)
app.post('/api/natural-booking', wrap(async (req, res) => {
  const { query, bookerTz } = req.body || {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Query string is required' });
  }
  const result = await nlp.parseAndFindSlots({ query: query.trim(), bookerTz: bookerTz || 'Asia/Kolkata' });
  res.json(result);
}));

app.post('/api/bookings', wrap(async (req, res) => send(res, await booking.createBooking({ ...req.body, studentId: user(req) }))));
app.post('/api/bookings/:id/release', wrap(async (req, res) => send(res, await booking.release(req.params.id, user(req), req.body && req.body.reason))));

// Waiting Queue endpoints
app.post('/api/waitlist', wrap(async (req, res) => send(res, await booking.joinWaitlist({ ...req.body, studentId: user(req) }))));
app.post('/api/waitlist/:id/leave', wrap(async (req, res) => send(res, await booking.leaveWaitlist(req.params.id, user(req)))));
app.get('/api/waitlist/my', wrap(async (req, res) => res.json(await booking.getUserWaitlist(user(req)))));

app.get('/api/bookings/history', wrap(async (req, res) => {
  const p = [user(req)];
  let q = `
    SELECT b.id, b."facultyId", b."startTime", b."endTime", b.status,
           u.name AS "facultyName", f.department, f.location,
           (SELECT timezone FROM "FacultySchedule" WHERE "facultyId"=b."facultyId" LIMIT 1) AS "facultyTimezone"
    FROM "Booking" b
    JOIN "Faculty" f ON f.id=b."facultyId"
    JOIN "User" u ON u.id=f."userId"
    WHERE b."studentId"=$1
  `;
  if (req.query.status) { p.push(req.query.status); q += ` AND b.status=$${p.length}`; }
  q += ' ORDER BY b."startTime" DESC';
  if (req.query.limit) { p.push(Number(req.query.limit)); q += ` LIMIT $${p.length}`; }
  const rows = (await pool.query(q, p)).rows;
  const ns = (await pool.query(`SELECT count(*)::int n FROM "Booking" WHERE "studentId"=$1 AND status='NO_SHOW'`, [user(req)])).rows[0].n;
  res.json({
    studentId: user(req),
    noShowCount: ns,
    bookings: rows.map(b => ({
      bookingId: b.id,
      facultyId: b.facultyId,
      facultyName: b.facultyName,
      department: b.department,
      location: b.location,
      facultyTimezone: b.facultyTimezone || 'Asia/Kolkata',
      startTime: b.startTime.toISOString(),
      endTime: b.endTime.toISOString(),
      status: b.status
    }))
  });
}));

// Rule-based no-show reminder (NS-2/NS-3): noShowCount >= 2 -> early reminder + "Release My Slot".
app.get('/api/reminders', wrap(async (req, res) => {
  const id = user(req);
  const ns = (await pool.query(`SELECT count(*)::int n FROM "Booking" WHERE "studentId"=$1 AND status='NO_SHOW'`, [id])).rows[0].n;
  const b = (await pool.query(`SELECT b.*, u.name, u2.timezone btz, (SELECT timezone FROM "FacultySchedule" WHERE "facultyId"=b."facultyId" LIMIT 1) htz
    FROM "Booking" b JOIN "Faculty" f ON f.id=b."facultyId" JOIN "User" u ON u.id=f."userId" JOIN "User" u2 ON u2.id=b."studentId"
    WHERE b."studentId"=$1 AND b.status='CONFIRMED' AND b."startTime">now() ORDER BY b."startTime" LIMIT 1`, [id])).rows[0];
  if (!b) return res.json({ upcoming: null, noShowCount: ns });
  const h = DateTime.fromJSDate(b.startTime, { zone: b.htz }), today = DateTime.now().setZone(b.htz).startOf('day');
  const days = Math.round(h.startOf('day').diff(today, 'days').days);
  res.json({ noShowCount: ns, earlyReminder: ns >= 2,
    upcoming: { bookingId: b.id, facultyName: b.name, when: (days === 1 ? 'Tomorrow' : h.toFormat('ccc, LLL d')) + ' · ' + h.toFormat('h:mm a') + ' IST' },
    message: ns >= 2 ? 'You have 2 or more earlier no-shows, so this reminder comes early. Release the slot if you cannot attend.' : 'Your booking starts soon.' });
}));

// Live Concurrency Race Simulator endpoint for UI testing
app.post('/api/demo/race', wrap(async (req, res) => {
  const { facultyId, startTime, endTime, student1 = 'student_A', student2 = 'student_B' } = req.body || {};
  if (!facultyId || !startTime || !endTime) {
    return res.status(400).json({ error: 'facultyId, startTime, endTime required' });
  }

  // Fire both booking requests concurrently at the exact same instant
  const [res1, res2] = await Promise.all([
    booking.createBooking({ facultyId, studentId: student1, startTime, endTime, idempotencyKey: 'race-1-' + Date.now() }),
    booking.createBooking({ facultyId, studentId: student2, startTime, endTime, idempotencyKey: 'race-2-' + Date.now() })
  ]);

  res.json({
    student1: { studentId: student1, status: res1.status, body: res1.body },
    student2: { studentId: student2, status: res2.status, body: res2.body }
  });
}));

// Internal killer-test endpoints (not linked from the normal UI)
for (const name of ['timezone', 'buffer'])
  app.post('/api/demo/' + name, wrap(async (req, res) => res.json(await demo[name]())));
app.post('/api/demo/concurrent', wrap(async (req, res) => res.json(await demo.concurrent(`${req.protocol}://${req.get('host')}`))));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Smart Slot Booking: http://localhost:${port}`));
