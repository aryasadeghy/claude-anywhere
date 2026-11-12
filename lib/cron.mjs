// A 5-field cron parser and "next run" calculator, written by hand rather than pulled in as a
// dependency (this package's one rule): minute hour day-of-month month day-of-week, each a
// number, '*', a list ("1,2,3"), a range ("1-5") or a step ("*/15", "1-10/2"). Local time
// throughout - a routine someone wrote "daily at 9am" for should still mean 9am after the clock
// changes, which a UTC scheduler would not give them.

const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const NAMES = [null, null, null,
  { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }];

function parsePart(part, lo, hi, names) {
  const set = new Set();
  for (let seg of part.split(',')) {
    let step = 1;
    const stepM = seg.match(/^(.+)\/(\d+)$/);
    if (stepM) { seg = stepM[1]; step = parseInt(stepM[2], 10); if (!step || step < 1) throw new Error('bad step'); }
    let from, to;
    if (seg === '*') { from = lo; to = hi; }
    else {
      const rangeM = seg.match(/^([^-]+)-([^-]+)$/);
      const num = (s) => { const t = s.toLowerCase(); if (names && names[t] !== undefined) return names[t]; const n = parseInt(s, 10); if (!Number.isFinite(n)) throw new Error('bad field: ' + s); return n; };
      if (rangeM) { from = num(rangeM[1]); to = num(rangeM[2]); }
      else { from = to = num(seg); }
    }
    if (from < lo || to > hi || from > to) throw new Error(`value out of range ${lo}-${hi}: ${seg}`);
    for (let v = from; v <= to; v += step) set.add(v);
  }
  return set;
}

/** Parses "m h dom mon dow" into five Sets. Throws with a readable message on anything malformed. */
export function parseCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('A schedule needs exactly 5 fields: minute hour day month weekday.');
  return fields.map((f, i) => parsePart(f, FIELD_RANGES[i][0], FIELD_RANGES[i][1], NAMES[i]));
}

function matches(sets, d) {
  const [min, hr, dom, mon, dow] = sets;
  // cron's day-of-month/day-of-week OR rule: either one being "*" defers entirely to the other.
  const domAny = min !== undefined && FIELD_RANGES[2][1] - FIELD_RANGES[2][0] + 1 === dom.size;
  const dowAny = FIELD_RANGES[4][1] - FIELD_RANGES[4][0] + 1 === dow.size;
  const domOk = dom.has(d.getDate()), dowOk = dow.has(d.getDay());
  const dayOk = domAny || dowAny ? (domAny ? dowOk : domOk) : (domOk || dowOk);
  return min.has(d.getMinutes()) && hr.has(d.getHours()) && mon.has(d.getMonth() + 1) && dayOk;
}

const MAX_MINUTES = 60 * 24 * 400; // ~400 days out - far enough for every real schedule, finite for Feb 30-style typos

/** The next local Date strictly after `from` (default now) that the cron expression matches, or null if none within ~400 days. */
export function nextRun(expr, from = new Date()) {
  const sets = parseCron(expr);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < MAX_MINUTES; i++) {
    if (matches(sets, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

const DOW_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm12 = (h, m) => { const ap = h < 12 ? 'AM' : 'PM'; const h12 = h % 12 || 12; return `${h12}:${pad2(m)} ${ap}`; };

/** A schedule descriptor (from the create/edit dialog) to a stored cron string. */
export function scheduleToCron(schedule) {
  const s = schedule || {};
  if (s.type === 'custom') { parseCron(s.cron); return s.cron.trim(); }
  const [h, m] = String(s.time || '09:00').split(':').map((n) => parseInt(n, 10) || 0);
  if (s.type === 'hourly') return `0 * * * *`;
  if (s.type === 'daily') return `${m} ${h} * * *`;
  if (s.type === 'weekdays') return `${m} ${h} * * 1-5`;
  if (s.type === 'weekly') return `${m} ${h} * * ${Number(s.day) || 0}`;
  throw new Error('Unknown schedule type: ' + s.type);
}

/** Plain-words description of a stored cron string, for the routine's card. */
export function describeCron(expr) {
  const sets = parseCron(expr);
  const [min, hr, dom, mon, dow] = sets;
  const full = (set, range) => set.size === range[1] - range[0] + 1;
  if (full(min, FIELD_RANGES[0]) === false && min.size === 1 && full(hr, FIELD_RANGES[1]) === false && hr.size === 1 && full(dom, FIELD_RANGES[2]) && full(mon, FIELD_RANGES[3])) {
    const h = [...hr][0], m = [...min][0], time = hhmm12(h, m);
    if (full(dow, FIELD_RANGES[4])) return `Daily at ${time}`;
    if (dow.size === 5 && [1, 2, 3, 4, 5].every((v) => dow.has(v))) return `Weekdays at ${time}`;
    if (dow.size === 1) return `Weekly on ${DOW_NAME[[...dow][0]]} at ${time}`;
  }
  if (min.size === 1 && [...min][0] === 0 && full(hr, FIELD_RANGES[1]) && full(dom, FIELD_RANGES[2]) && full(mon, FIELD_RANGES[3]) && full(dow, FIELD_RANGES[4])) return 'Every hour';
  return `Custom: ${expr}`;
}
