const { DateTime } = require('luxon');
const pool = require('./db');
const engine = require('./engine');

/**
 * Natural Language Booking Parser & Slot Finder
 * 
 * Philosophy:
 * "The AI never decides availability, it only parses the request, so it can't break correctness."
 * 1. Parse text -> { facultyId, date, duration, timeWindow }
 * 2. Feed structured filters -> engine.getSlots(...)
 * 3. Return real free slots verified by Postgres constraints, buffers, and working hours.
 */

// Helper to query available faculty for matching
async function getFacultyList() {
  const r = await pool.query(`
    SELECT f.id, u.name, f.department,
           (SELECT timezone FROM "FacultySchedule" WHERE "facultyId"=f.id LIMIT 1) AS timezone
    FROM "Faculty" f JOIN "User" u ON u.id=f."userId"
    WHERE f.id != 'fac_test'
  `);
  return r.rows;
}

// Built-in Deterministic / Rule-based NLP Parser
function parseNaturalLanguageRuleBased(text, facultyList, bookerTz = 'Asia/Kolkata') {
  const lower = text.toLowerCase();
  const now = DateTime.now().setZone(bookerTz);

  // 1. Match Faculty
  let matchedFaculty = null;
  for (const f of facultyList) {
    const fLower = f.name.toLowerCase();
    const lastName = fLower.split(' ').pop();
    if (lower.includes(lastName) || lower.includes(fLower) || (f.id && lower.includes(f.id))) {
      matchedFaculty = f;
      break;
    }
  }
  // Default to first faculty if none explicitly mentioned
  if (!matchedFaculty && facultyList.length > 0) {
    matchedFaculty = facultyList[0];
  }

  // 2. Match Duration (minutes)
  let duration = 30; // default
  if (/half\s+an?\s+hour/i.test(lower)) {
    duration = 30;
  } else if (/an?\s+hour/i.test(lower)) {
    duration = 60;
  } else {
    const durMatch = lower.match(/\b(\d+)\s*(?:min|mins|minute|minutes|m)\b/i);
    if (durMatch) {
      duration = parseInt(durMatch[1], 10);
    } else {
      const hrMatch = lower.match(/\b(\d+)\s*(?:hour|hours|hr|hrs|h)\b/i);
      if (hrMatch) {
        duration = parseInt(hrMatch[1], 10) * 60;
      }
    }
  }

  // 3. Match Date
  const weekdays = {
    monday: 1, mon: 1,
    tuesday: 2, tue: 2, tues: 2,
    wednesday: 3, wed: 3,
    thursday: 4, thu: 4, thur: 4, thurs: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6,
    sunday: 7, sun: 7
  };

  let targetDate = null;
  const isNext = /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i.test(lower);

  // Check explicit "today", "tomorrow"
  if (/\btoday\b/i.test(lower)) {
    targetDate = now;
  } else if (/\btomorrow\b/i.test(lower)) {
    targetDate = now.plus({ days: 1 });
  } else if (/\bday\s+after\s+tomorrow\b/i.test(lower)) {
    targetDate = now.plus({ days: 2 });
  } else {
    // Check weekday mentions
    for (const [dayName, dayNum] of Object.entries(weekdays)) {
      const dayRegex = new RegExp(`\\b${dayName}\\b`, 'i');
      if (dayRegex.test(lower)) {
        let diff = dayNum - now.weekday;
        if (diff <= 0) diff += 7; // next occurrence
        if (isNext && diff < 7) diff += 7; // "next Thursday" when already upcoming
        targetDate = now.plus({ days: diff });
        break;
      }
    }
  }

  // Fallback: If no date specified, choose next available weekday
  if (!targetDate) {
    let d = now;
    if (d.hour >= 17) d = d.plus({ days: 1 });
    while (d.weekday === 6 || d.weekday === 7) {
      d = d.plus({ days: 1 });
    }
    targetDate = d;
  }

  const dateIso = targetDate.toISODate();

  // 4. Match Time Window (morning, afternoon, evening, or specific hour)
  let timeWindow = 'any';
  let timeWindowLabel = 'Any time during working hours';
  let hourStart = null;
  let hourEnd = null;

  if (/\bmorning\b/i.test(lower)) {
    timeWindow = 'morning';
    timeWindowLabel = 'Morning (8:30 AM – 12:00 PM)';
    hourStart = 8;
    hourEnd = 12;
  } else if (/\bafternoon\b/i.test(lower)) {
    timeWindow = 'afternoon';
    timeWindowLabel = 'Afternoon (12:00 PM – 5:00 PM)';
    hourStart = 12;
    hourEnd = 17;
  } else if (/\bevening\b/i.test(lower)) {
    timeWindow = 'evening';
    timeWindowLabel = 'Evening (5:00 PM onwards)';
    hourStart = 17;
    hourEnd = 21;
  } else {
    // Check specific hour like "at 2pm", "2:30 pm"
    const specificTime = lower.match(/\b(?:at|around)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    if (specificTime) {
      let h = parseInt(specificTime[1], 10);
      const isPm = specificTime[3] === 'pm';
      if (isPm && h < 12) h += 12;
      if (specificTime[3] === 'am' && h === 12) h = 0;
      hourStart = h;
      hourEnd = h + 1.5;
      timeWindow = 'specific';
      timeWindowLabel = `Around ${h > 12 ? h - 12 : h}:00 ${isPm ? 'PM' : 'AM'}`;
    }
  }

  return {
    facultyId: matchedFaculty ? matchedFaculty.id : null,
    facultyName: matchedFaculty ? matchedFaculty.name : 'Unknown Faculty',
    duration,
    date: dateIso,
    dateFormatted: targetDate.toFormat('cccc, LLL d'),
    timeWindow,
    timeWindowLabel,
    hourStart,
    hourEnd,
    parser: 'deterministic'
  };
}

// Optional LLM Call (if LLM_API_KEY is configured in .env)
async function parseWithLLM(query, facultyList, bookerTz) {
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey || typeof fetch === 'undefined') {
    return null;
  }

  const prompt = `You are a booking request parser. Given a student's request, extract structured criteria.
Faculty list:
${facultyList.map(f => `- ID "${f.id}": ${f.name} (${f.department})`).join('\n')}

Reference timezone: ${bookerTz}
Current reference date/time: ${DateTime.now().setZone(bookerTz).toISO()}

Student request: "${query}"

Return STRICT JSON ONLY, no other words, no markdown backticks:
{
  "facultyId": "<id or null>",
  "duration": <number of minutes, e.g. 30>,
  "date": "<YYYY-MM-DD>",
  "timeWindow": "<morning|afternoon|evening|any>",
  "explanation": "<brief summary>"
}`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0
      }),
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    const cleanJson = content.replace(/^```json/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(cleanJson);
    const faculty = facultyList.find(f => f.id === parsed.facultyId) || facultyList[0];
    const dt = DateTime.fromISO(parsed.date, { zone: bookerTz });

    return {
      facultyId: faculty.id,
      facultyName: faculty.name,
      duration: Number(parsed.duration) || 30,
      date: parsed.date,
      dateFormatted: dt.isValid ? dt.toFormat('cccc, LLL d') : parsed.date,
      timeWindow: parsed.timeWindow || 'any',
      timeWindowLabel: parsed.timeWindow === 'morning' ? 'Morning (8:30 AM – 12:00 PM)'
        : parsed.timeWindow === 'afternoon' ? 'Afternoon (12:00 PM – 5:00 PM)'
        : parsed.timeWindow === 'evening' ? 'Evening (5:00 PM onwards)' : 'Any time',
      hourStart: parsed.timeWindow === 'morning' ? 8 : parsed.timeWindow === 'afternoon' ? 12 : parsed.timeWindow === 'evening' ? 17 : null,
      hourEnd: parsed.timeWindow === 'morning' ? 12 : parsed.timeWindow === 'afternoon' ? 17 : parsed.timeWindow === 'evening' ? 21 : null,
      parser: 'llm'
    };
  } catch (err) {
    // If LLM fails or times out, smoothly fallback to rule-based parser
    return null;
  }
}

/**
 * Main Entry Point: parseAndFindSlots
 * Takes natural language query, extracts filters, and queries the real slot engine.
 */
async function parseAndFindSlots({ query, bookerTz = 'Asia/Kolkata' }) {
  if (!query || typeof query !== 'string') {
    throw new Error('Query string is required');
  }

  const facultyList = await getFacultyList();

  // Try LLM if configured, else fallback to deterministic rule parser
  let parsed = await parseWithLLM(query, facultyList, bookerTz);
  if (!parsed) {
    parsed = parseNaturalLanguageRuleBased(query, facultyList, bookerTz);
  }

  // CRITICAL PRINCIPLE:
  // "The AI never decides availability, it only parses the request, so it can't break correctness."
  // Query the underlying scheduling engine for actual slots:
  const slotRes = await engine.getSlots({
    facultyId: parsed.facultyId,
    date: parsed.date,
    duration: parsed.duration,
    step: 15,
    bookerTz
  });

  if (!slotRes) {
    return {
      success: false,
      query,
      parsed,
      error: 'Faculty not found or invalid parameters'
    };
  }

  // Handle Day-Off or Holiday
  if (slotRes.dayOff) {
    // Find next working day for helpful alternative suggestions
    let altDate = DateTime.fromISO(parsed.date, { zone: bookerTz }).plus({ days: 1 });
    while (altDate.weekday === 6 || altDate.weekday === 7) altDate = altDate.plus({ days: 1 });
    const altRes = await engine.getSlots({
      facultyId: parsed.facultyId,
      date: altDate.toISODate(),
      duration: parsed.duration,
      step: 15,
      bookerTz
    });
    let altMatching = [];
    if (altRes && !altRes.dayOff) {
      const free = altRes.slots.filter(s => s.status === 'available');
      if (parsed.hourStart !== null && parsed.hourEnd !== null) {
        altMatching = free.filter(s => {
          const hHour = parseInt(s.host.start.split(':')[0], 10) + parseInt(s.host.start.split(':')[1], 10) / 60;
          const bHour = parseInt(s.booker.start.split(':')[0], 10) + parseInt(s.booker.start.split(':')[1], 10) / 60;
          return (hHour >= parsed.hourStart && hHour < parsed.hourEnd) || (bHour >= parsed.hourStart && bHour < parsed.hourEnd);
        });
      } else {
        altMatching = free;
      }
    }

    return {
      success: true,
      query,
      parsed,
      dayOff: true,
      dayOffReason: slotRes.reason || 'Faculty unavailable on this date',
      matchingSlots: [],
      allAvailableSlots: [],
      alternativeDate: altDate.toISODate(),
      alternativeDateFormatted: altDate.toFormat('cccc, LLL d'),
      alternativeSlots: altMatching,
      message: `🚫 ${parsed.facultyName} has a scheduled Day-Off on ${parsed.dateFormatted} (${slotRes.reason || 'Unavailable'}). Correctness preserved: no slots can be booked on days off.`
    };
  }

  // Filter available slots according to time window
  const available = slotRes.slots.filter(s => s.status === 'available');
  let matching = available;

  if (parsed.hourStart !== null && parsed.hourEnd !== null) {
    matching = available.filter(s => {
      // Check in host time or booker time
      const hHour = parseInt(s.host.start.split(':')[0], 10) + parseInt(s.host.start.split(':')[1], 10) / 60;
      const bHour = parseInt(s.booker.start.split(':')[0], 10) + parseInt(s.booker.start.split(':')[1], 10) / 60;
      return (hHour >= parsed.hourStart && hHour < parsed.hourEnd) || (bHour >= parsed.hourStart && bHour < parsed.hourEnd);
    });
  }

  return {
    success: true,
    query,
    parsed,
    dayOff: false,
    matchingSlots: matching,
    allAvailableSlots: available,
    allAvailableCount: available.length,
    message: matching.length > 0
      ? `Found ${matching.length} matching slot${matching.length > 1 ? 's' : ''} for ${parsed.facultyName} on ${parsed.dateFormatted} (${parsed.timeWindowLabel}).`
      : `No free slots in the requested ${parsed.timeWindowLabel} window, but ${available.length} other slot${available.length > 1 ? 's are' : ' is'} available on ${parsed.dateFormatted}.`
  };
}

module.exports = {
  parseNaturalLanguageRuleBased,
  parseAndFindSlots,
  getFacultyList
};
