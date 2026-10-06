// Booking Service + Atomic Booking Guard.
const crypto = require('crypto');
const { DateTime } = require('luxon');
const pool = require('./db');
const engine = require('./engine');

async function createBooking({ facultyId, studentId, startTime, endTime, idempotencyKey, title, notes }) {
  const s = Date.parse(startTime), e = Date.parse(endTime);
  if (!facultyId || !studentId || isNaN(s) || isNaN(e) || e <= s || (e - s) % 300000)
    return { status: 400, body: { error: 'facultyId, studentId, startTime, endTime required (ISO 8601 UTC, 5-minute multiples)' } };

  // Idempotent retry (CON-4): same key returns the original booking.
  if (idempotencyKey) {
    const ex = await pool.query('SELECT * FROM "Booking" WHERE "idempotencyKey"=$1', [idempotencyKey]);
    if (ex.rows[0]) return { status: 200, body: shape(ex.rows[0]) };
  }
  const tz = await engine.hostTz(facultyId);
  if (!tz) return { status: 400, body: { error: 'unknown faculty' } };
  const w = await engine.workingWindow(facultyId, DateTime.fromMillis(s, { zone: tz }).toISODate());
  if (!w || w.start == null || s < w.start || e > w.end)
    return { status: 400, body: { error: 'outside faculty working hours' } };

  const bufferEnd = new Date(e + engine.BUF * engine.MIN);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Friendly early exit only. NOT trusted: under READ COMMITTED two requests can both pass this check.
    const hit = await client.query(
      `SELECT 1 FROM "Booking" WHERE "facultyId"=$1 AND status='CONFIRMED' AND tstzrange("startTime","bufferEnd") && tstzrange($2,$3)`,
      [facultyId, new Date(s), bufferEnd]);
    if (hit.rowCount) { await client.query('ROLLBACK'); return conflict(); }
    // Authoritative guard: the EXCLUDE constraint (booking_no_overlap) rejects the loser with SQLSTATE 23P01.
    const id = 'bk_' + crypto.randomUUID().slice(0, 8);
    const ins = await client.query(
      `INSERT INTO "Booking"(id,"studentId","facultyId","startTime","endTime","bufferEnd","idempotencyKey",title,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id, studentId, facultyId, new Date(s), new Date(e), bufferEnd, idempotencyKey || null, title || null, notes || null]);
    await client.query('COMMIT');
    return { status: 201, body: shape(ins.rows[0]) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23P01') return conflict();
    if (err.code === '23503') return { status: 400, body: { error: 'unknown student or faculty' } };
    if (err.code === '23505') {
      const ex = await pool.query('SELECT * FROM "Booking" WHERE "idempotencyKey"=$1', [idempotencyKey]);
      if (ex.rows[0]) return { status: 200, body: shape(ex.rows[0]) };
    }
    throw err;
  } finally { client.release(); }
}
const conflict = () => ({ status: 409, body: { error: 'Slot is no longer available' } });
const shape = r => ({ bookingId: r.id, facultyId: r.facultyId, studentId: r.studentId, startTime: r.startTime.toISOString(), endTime: r.endTime.toISOString(), status: r.status });

async function release(id, studentId, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM "Booking" WHERE id=$1 FOR UPDATE', [id]);
    const b = r.rows[0];
    if (!b) {
      await client.query('ROLLBACK');
      return { status: 404, body: { error: 'booking not found' } };
    }
    if (b.studentId !== studentId) {
      await client.query('ROLLBACK');
      return { status: 403, body: { error: 'not your booking' } };
    }
    if (b.status !== 'CONFIRMED') {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: 'booking already ' + b.status.toLowerCase() } };
    }

    // Mark current booking CANCELLED
    await client.query(
      `UPDATE "Booking" SET status='CANCELLED', notes=COALESCE($2,notes), "updatedAt"=now() WHERE id=$1`,
      [id, reason || null]
    );

    // Check if there is an active waiting queue entry for this slot
    const wlRes = await client.query(
      `SELECT w.*, u.name AS "studentName"
       FROM "Waitlist" w
       JOIN "User" u ON u.id=w."studentId"
       WHERE w."facultyId"=$1 AND w."startTime"=$2 AND w.status='WAITING'
       ORDER BY w."createdAt" ASC
       LIMIT 1 FOR UPDATE`,
      [b.facultyId, b.startTime]
    );

    let promoted = null;
    let message = 'Slot released successfully. It is now available for other students.';

    if (wlRes.rows.length > 0) {
      const wl = wlRes.rows[0];
      const newBookingId = 'bk_' + crypto.randomUUID().slice(0, 8);
      const bufferEnd = new Date(wl.endTime.getTime() + engine.BUF * engine.MIN);

      // Create new confirmed booking for the WL1 student
      const ins = await client.query(
        `INSERT INTO "Booking"(id, "studentId", "facultyId", "startTime", "endTime", "bufferEnd", title, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [newBookingId, wl.studentId, wl.facultyId, wl.startTime, wl.endTime, bufferEnd,
         'Promoted from Waiting Queue (WL1)',
         `Automatically promoted after booking ${id} was cancelled.`]
      );

      // Update waitlist entry status to PROMOTED
      await client.query(
        `UPDATE "Waitlist" SET status='PROMOTED', "updatedAt"=now() WHERE id=$1`,
        [wl.id]
      );

      promoted = {
        waitlistId: wl.id,
        bookingId: newBookingId,
        studentId: wl.studentId,
        studentName: wl.studentName,
        startTime: wl.startTime.toISOString(),
        endTime: wl.endTime.toISOString(),
        status: 'CONFIRMED'
      };

      message = `Slot released. Waiting queue student ${wl.studentName} (${wl.studentId}) was automatically promoted to CONFIRMED!`;
    }

    await client.query('COMMIT');
    return {
      status: 200,
      body: {
        bookingId: id,
        status: 'CANCELLED',
        promoted,
        message
      }
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function joinWaitlist({ facultyId, studentId, startTime, endTime }) {
  const s = Date.parse(startTime), e = Date.parse(endTime);
  if (!facultyId || !studentId || isNaN(s) || isNaN(e) || e <= s)
    return { status: 400, body: { error: 'facultyId, studentId, startTime, endTime required (ISO 8601 UTC)' } };

  const tz = await engine.hostTz(facultyId);
  if (!tz) return { status: 400, body: { error: 'unknown faculty' } };

  // Check if student already has a confirmed booking for this exact slot
  const existingBk = await pool.query(
    `SELECT id FROM "Booking" WHERE "facultyId"=$1 AND "studentId"=$2 AND "startTime"=$3 AND status='CONFIRMED'`,
    [facultyId, studentId, new Date(s)]
  );
  if (existingBk.rows.length > 0) {
    return { status: 400, body: { error: 'You already have a confirmed booking for this slot.' } };
  }

  // Check if student is already waiting in queue for this exact slot
  const existingWl = await pool.query(
    `SELECT id FROM "Waitlist" WHERE "facultyId"=$1 AND "studentId"=$2 AND "startTime"=$3 AND status='WAITING'`,
    [facultyId, studentId, new Date(s)]
  );
  if (existingWl.rows.length > 0) {
    return { status: 400, body: { error: 'You are already in the waiting queue for this slot.' } };
  }

  // Calculate current queue count to determine WL position
  const countRes = await pool.query(
    `SELECT count(*)::int AS count FROM "Waitlist" WHERE "facultyId"=$1 AND "startTime"=$2 AND status='WAITING'`,
    [facultyId, new Date(s)]
  );
  const position = (countRes.rows[0]?.count || 0) + 1;
  const id = 'wl_' + crypto.randomUUID().slice(0, 8);

  const ins = await pool.query(
    `INSERT INTO "Waitlist"(id, "studentId", "facultyId", "startTime", "endTime", status)
     VALUES ($1, $2, $3, $4, $5, 'WAITING') RETURNING *`,
    [id, studentId, facultyId, new Date(s), new Date(e)]
  );

  return {
    status: 201,
    body: {
      waitlistId: id,
      position,
      queueCode: 'WL' + position,
      facultyId,
      studentId,
      startTime: new Date(s).toISOString(),
      endTime: new Date(e).toISOString(),
      status: 'WAITING',
      message: `Joined waiting queue at position WL${position}. If the confirmed booking cancels, you will be automatically promoted!`
    }
  };
}

async function leaveWaitlist(waitlistId, studentId) {
  const r = await pool.query('SELECT * FROM "Waitlist" WHERE id=$1', [waitlistId]);
  const wl = r.rows[0];
  if (!wl) return { status: 404, body: { error: 'waitlist entry not found' } };
  if (wl.studentId !== studentId) return { status: 403, body: { error: 'not your waitlist entry' } };
  if (wl.status !== 'WAITING') return { status: 400, body: { error: `Cannot leave: status is ${wl.status}` } };

  await pool.query(`UPDATE "Waitlist" SET status='CANCELLED', "updatedAt"=now() WHERE id=$1`, [waitlistId]);
  return { status: 200, body: { waitlistId, status: 'CANCELLED', message: 'Successfully removed from waiting queue.' } };
}

async function getUserWaitlist(studentId) {
  const q = `
    SELECT w.id, w."facultyId", w."studentId", w."startTime", w."endTime", w.status, w."createdAt",
           u.name AS "facultyName", f.department, f.location,
           (SELECT timezone FROM "FacultySchedule" WHERE "facultyId"=w."facultyId" LIMIT 1) AS "facultyTimezone"
    FROM "Waitlist" w
    JOIN "Faculty" f ON f.id=w."facultyId"
    JOIN "User" u ON u.id=f."userId"
    WHERE w."studentId"=$1
    ORDER BY w."createdAt" DESC
  `;
  const rows = (await pool.query(q, [studentId])).rows;

  const result = [];
  for (const r of rows) {
    let position = null;
    let queueCode = null;
    if (r.status === 'WAITING') {
      const posRes = await pool.query(
        `SELECT count(*)::int AS pos FROM "Waitlist"
         WHERE "facultyId"=$1 AND "startTime"=$2 AND status='WAITING' AND "createdAt" <= $3`,
        [r.facultyId, r.startTime, r.createdAt]
      );
      position = posRes.rows[0]?.pos || 1;
      queueCode = 'WL' + position;
    }
    result.push({
      waitlistId: r.id,
      facultyId: r.facultyId,
      facultyName: r.facultyName,
      department: r.department,
      location: r.location,
      facultyTimezone: r.facultyTimezone || 'Asia/Kolkata',
      startTime: r.startTime.toISOString(),
      endTime: r.endTime.toISOString(),
      status: r.status,
      position,
      queueCode,
      createdAt: r.createdAt.toISOString()
    });
  }

  return { waitlist: result };
}

module.exports = { createBooking, release, joinWaitlist, leaveWaitlist, getUserWaitlist };
