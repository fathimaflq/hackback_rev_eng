// Killer-test runners. They exercise the real engine, booking service and PostgreSQL (faculty "fac_test").
const { DateTime } = require('luxon');
const pool = require('./db');
const engine = require('./engine');
const { createBooking } = require('./booking');
const HOST = 'Asia/Kolkata', LA = 'America/Los_Angeles', F = 'fac_test', DATE = '2026-10-14';
const at = (h, m) => DateTime.fromISO(`${DATE}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, { zone: HOST });
const reset = () => pool.query('DELETE FROM "Booking" WHERE "facultyId"=$1', [F]);
const req = (s, student, key) => ({ facultyId: F, studentId: student, startTime: s.toUTC().toISO(), endTime: s.plus({ minutes: 30 }).toUTC().toISO(), idempotencyKey: key });

async function timezone() {
  await reset();
  const s = at(11, 0);
  const r = await engine.getSlots({ facultyId: F, date: DATE, duration: 30, step: 30, bookerTz: LA });
  const slot = r.slots.find(x => x.startTime === s.toUTC().toISO());
  const checks = {
    utcIs0530: !!slot && slot.startTime === '2026-10-14T05:30:00.000Z',
    hostIs11AM_IST: !!slot && slot.host.start12 === '11:00 AM' && slot.host.zone === 'IST',
    bookerIs1030PM_PDT_prevDay: !!slot && slot.booker.start12 === '10:30 PM' && slot.booker.zone === 'PDT' && slot.booker.date === 'Tue, Oct 13'
  };
  return { test: 'timezone', pass: Object.values(checks).every(Boolean), checks, slot };
}

async function buffer() {
  await reset();
  const seed = await createBooking(req(at(10, 0), 'stu_seed', null));
  const probes = [];
  for (const [h, m, expect] of [[10, 30, 409], [10, 40, 409], [10, 45, 201]]) {
    const s = at(h, m);
    const engineSays = (await engine.getSlots({ facultyId: F, date: DATE, duration: 30, step: 5, bookerTz: LA })).slots.find(x => x.startTime === s.toUTC().toISO()).status;
    const r = await createBooking(req(s, 'student_B', null));
    probes.push({ time: s.toFormat('HH:mm') + ' IST', engine: engineSays, httpStatus: r.status, expected: expect, ok: r.status === expect });
  }
  return { test: 'buffer', pass: seed.status === 201 && probes.every(p => p.ok), seedStatus: seed.status, bufferMinutes: engine.BUF, probes };
}

async function concurrent(origin) {
  await reset();
  const s = at(11, 0);
  const call = (student, key) => fetch(origin + '/api/bookings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': student }, body: JSON.stringify(req(s, student, key)) }).then(r => r.status);
  const [a, b] = await Promise.all([call('student_A', 'A-key'), call('student_B', 'B-key')]);
  const n = (await pool.query(`SELECT count(*)::int n FROM "Booking" WHERE "facultyId"=$1 AND status='CONFIRMED' AND "startTime"=$2`, [F, s.toJSDate()])).rows[0].n;
  return { test: 'concurrent', pass: [a, b].sort().join() === '201,409' && n === 1, studentA: a, studentB: b, confirmedBookings: n };
}
module.exports = { timezone, buffer, concurrent };
