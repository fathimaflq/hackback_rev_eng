// Availability Engine: source of truth for slot availability. All comparisons use UTC epoch ms.
const { DateTime } = require('luxon');
const pool = require('./db');
const BUF = Number(process.env.BUFFER_MINUTES || 15);
const MIN = 60000;

async function hostTz(facultyId) {
  const r = await pool.query('SELECT timezone FROM "FacultySchedule" WHERE "facultyId"=$1 LIMIT 1', [facultyId]);
  return r.rows[0] && r.rows[0].timezone;
}

// Returns the date override for a given faculty + local date (YYYY-MM-DD), or null.
async function getOverride(facultyId, date) {
  const r = await pool.query(
    'SELECT * FROM "FacultyDateOverride" WHERE "facultyId"=$1 AND date=$2',
    [facultyId, date]);
  return r.rows[0] || null;
}

// Working window for a host-local calendar date, as UTC instants. null if not a working day.
// Returns { tz, start, end } — start/end are null when no schedule for that weekday.
// Returns { tz, start: null, end: null, dayOff: true, reason } when a DAY_OFF override applies.
async function workingWindow(facultyId, date) {
  const tz = await hostTz(facultyId);
  if (!tz) return null;
  const day = DateTime.fromISO(date, { zone: tz });
  if (!day.isValid) return null;

  // Check date override first — overrides take precedence over the regular schedule.
  const override = await getOverride(facultyId, date);
  if (override) {
    if (override.type === 'DAY_OFF') {
      return { tz, start: null, end: null, dayOff: true, reason: override.reason || 'Faculty unavailable' };
    }
    if (override.type === 'CUSTOM_HOURS' && override.startTime && override.endTime) {
      const at = hhmm => { const [h, m] = hhmm.split(':').map(Number); return day.set({ hour: h, minute: m }).toMillis(); };
      return { tz, start: at(override.startTime), end: at(override.endTime), customHours: true, customStart: override.startTime, customEnd: override.endTime };
    }
  }

  // Fall back to regular weekly schedule.
  const r = await pool.query('SELECT "startTime","endTime" FROM "FacultySchedule" WHERE "facultyId"=$1 AND "dayOfWeek"=$2', [facultyId, day.weekday % 7]);
  if (!r.rows.length) return { tz, start: null, end: null };
  const at = hhmm => { const [h, m] = hhmm.split(':').map(Number); return day.set({ hour: h, minute: m }).toMillis(); };
  return { tz, start: at(r.rows[0].startTime), end: at(r.rows[0].endTime) };
}

async function busy(facultyId, from, to) {
  const r = await pool.query(
    `SELECT "id", "studentId", "startTime","endTime","bufferEnd" FROM "Booking"
     WHERE "facultyId"=$1 AND status='CONFIRMED' AND tstzrange("startTime","bufferEnd") && tstzrange($2,$3)`,
    [facultyId, new Date(from), new Date(to)]);
  return r.rows.map(b => ({ id: b.id, studentId: b.studentId, s: +b.startTime, e: +b.endTime, be: +b.bufferEnd }));
}

async function waitlists(facultyId, from, to) {
  const r = await pool.query(
    `SELECT id, "studentId", "startTime", "createdAt" FROM "Waitlist"
     WHERE "facultyId"=$1 AND status='WAITING' AND "startTime" >= $2 AND "startTime" <= $3
     ORDER BY "createdAt" ASC`,
    [facultyId, new Date(from), new Date(to)]
  );
  return r.rows.map(w => ({ id: w.id, studentId: w.studentId, s: +w.startTime, createdAt: w.createdAt }));
}

// A candidate slot [s,e) needs [s, e+buffer) to be free of every existing [start, end+buffer).
function classify(rows, s, e) {
  let st = 'available';
  for (const b of rows) {
    if (s < b.e && e > b.s) return 'booked';
    if (s < b.be && e + BUF * MIN > b.s) st = 'buffer';
  }
  return st;
}

// Strings computed on the server with real timezone conversion (luxon / IANA tz database).
function describe(s, e, hostZone, bookerZone) {
  const h = DateTime.fromMillis(s, { zone: hostZone }), he = DateTime.fromMillis(e, { zone: hostZone });
  const b = DateTime.fromMillis(s, { zone: bookerZone }), be = DateTime.fromMillis(e, { zone: bookerZone });
  const zn = (d, z) => (z === 'Asia/Kolkata' ? 'IST' : d.offsetNameShort);
  return {
    host: { start: h.toFormat('HH:mm'), end: he.toFormat('HH:mm'), start12: h.toFormat('h:mm a'), end12: he.toFormat('h:mm a'), zone: zn(h, hostZone), date: h.toFormat('cccc, LLLL d, yyyy'), timezone: hostZone },
    booker: { start: b.toFormat('HH:mm'), start12: b.toFormat('h:mm a'), end12: be.toFormat('h:mm a'), zone: zn(b, bookerZone), date: b.toFormat('ccc, LLL d'), timezone: bookerZone },
    utc: { start: DateTime.fromMillis(s, { zone: 'utc' }).toFormat('HH:mm'), end: DateTime.fromMillis(e, { zone: 'utc' }).toFormat('HH:mm') }
  };
}

async function getSlots({ facultyId, date, duration, step, bookerTz, studentId }) {
  const w = await workingWindow(facultyId, date);
  if (!w) return null;
  // Day-off override: return sentinel with empty slots and a message.
  if (w.dayOff) return { hostTz: w.tz, dayOff: true, reason: w.reason, slots: [] };
  const out = [];
  if (w.start != null) {
    const [rows, wlRows] = await Promise.all([
      busy(facultyId, w.start - 3600000, w.end + 3600000),
      waitlists(facultyId, w.start - 3600000, w.end + 3600000)
    ]);
    for (let s = w.start; s + duration * MIN <= w.end; s += step * MIN) {
      const e = s + duration * MIN;
      const status = classify(rows, s, e);
      const booking = rows.find(b => s < b.e && e > b.s);
      const slotWl = wlRows.filter(wl => wl.s === s);
      const waitlistCount = slotWl.length;
      const myWlIndex = studentId ? slotWl.findIndex(wl => wl.studentId === studentId) : -1;
      const myWaitlist = myWlIndex >= 0 ? {
        waitlistId: slotWl[myWlIndex].id,
        position: myWlIndex + 1,
        queueCode: 'WL' + (myWlIndex + 1)
      } : null;

      out.push({
        startTime: new Date(s).toISOString(),
        endTime: new Date(e).toISOString(),
        status,
        bookingId: booking ? booking.id : null,
        bookedBy: booking ? booking.studentId : null,
        isMyBooking: !!(studentId && booking && booking.studentId === studentId),
        waitlistCount,
        myWaitlist,
        ...describe(s, e, w.tz, bookerTz)
      });
    }
  }
  return { hostTz: w.tz, customHours: w.customHours || false, slots: out };
}

module.exports = { BUF, MIN, hostTz, workingWindow, getSlots, describe, classify, busy, getOverride };
