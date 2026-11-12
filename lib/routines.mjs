// Scheduled tasks ("routines"): Claude running itself, on this computer, on a schedule - not a
// held message like lib/limit-queue.mjs (which waits on a usage limit, not a clock). A routine's
// run is a normal session, same as one you start by hand, so it opens, forks and is told to
// anyone who opens the folder; only the row in routines.json ties a session back to the routine
// that started it. A plain setInterval does the waking up, same reasoning as limit-queue.mjs:
// nothing else about this app polls on a clock, and a routine due while the server is asleep
// needs someone to notice when it comes back, not a timer that was never running to fire.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nextRun, scheduleToCron, describeCron } from './cron.mjs';

let FILE = null;
let store = { routines: {} }; // id -> routine row (schedule, folder, last/next run, a capped run history)
let timer = null;
let starter = null; // injected from server.mjs: (routine) => Promise<{ sessionId }>

const RUN_HISTORY_CAP = 25;
const MISSED_WINDOW_MS = 24 * 60 * 60 * 1000; // "within the last day" per the spec

function save() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(store)); } catch {} }

export function init(dataDir, { onDue } = {}) {
  FILE = path.join(dataDir, 'routines.json');
  try { store = { routines: {}, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { store = { routines: {} }; }
  starter = onDue || null;
  clearInterval(timer);
  // Once a minute is as fine-grained as cron itself gets; checking more often buys nothing.
  timer = setInterval(() => { tick().catch(() => {}); }, 30000);
  timer.unref?.();
  // A routine due while the server was down runs once on startup, if that due time was within
  // the last day - older than that and it is treated as missed for good, per the spec, rather
  // than firing a backlog of runs the moment the server comes back.
  return catchUpMissed();
}

export function list() { return Object.values(store.routines).sort((a, b) => b.createdAt - a.createdAt); }
export function get(id) { return store.routines[id] || null; }

function toRow(input, existing) {
  const cron = scheduleToCron(input.schedule); // throws on a bad custom expression - caught by the route/tool, not swallowed here
  const row = {
    id: existing?.id || randomUUID(),
    name: String(input.name || '').trim() || 'Untitled routine',
    prompt: String(input.prompt || ''),
    folder: String(input.folder || existing?.folder || ''),
    model: input.model || existing?.model || '',
    permissionMode: input.permissionMode || existing?.permissionMode || 'default',
    schedule: { ...input.schedule, cron },
    enabled: input.enabled !== undefined ? !!input.enabled : (existing ? existing.enabled : true),
    createdAt: existing?.createdAt || Date.now(),
    lastRunAt: existing?.lastRunAt || null,
    lastRunStatus: existing?.lastRunStatus || null,
    runs: existing?.runs || [],
    missedAtStartup: false,
  };
  row.nextRunAt = row.enabled ? nextRun(cron)?.getTime() ?? null : null;
  return row;
}

export function create(input) {
  const row = toRow(input, null);
  store.routines[row.id] = row;
  save();
  return row;
}

export function update(id, input) {
  const existing = store.routines[id];
  if (!existing) return null;
  const row = toRow({ ...existing, ...input, schedule: input.schedule || existing.schedule }, existing);
  store.routines[id] = row;
  save();
  return row;
}

export function remove(id) {
  const had = !!store.routines[id];
  delete store.routines[id];
  save();
  return had;
}

export function describe(routine) { return describeCron(routine.schedule.cron); }

/** The routine that started this session, if any - for the sidebar's "Scheduled" tag. */
export function nameForSession(sessionId) {
  for (const routine of Object.values(store.routines)) if (routine.runs.some((r) => r.sessionId === sessionId)) return routine.name;
  return null;
}

function recordRun(routine, sessionId, status) {
  routine.runs = [{ id: randomUUID(), sessionId, startedAt: Date.now(), status }, ...routine.runs].slice(0, RUN_HISTORY_CAP);
  routine.lastRunAt = Date.now();
  routine.lastRunStatus = status;
  save();
}

async function fire(routine, { missed = false } = {}) {
  if (!starter) return;
  try {
    const { sessionId } = await starter(routine);
    recordRun(routine, sessionId, missed ? 'missed-at-startup' : 'started');
  } catch (e) {
    recordRun(routine, null, 'failed');
  } finally {
    routine.nextRunAt = routine.enabled ? nextRun(routine.schedule.cron)?.getTime() ?? null : null;
    save();
  }
}

/** Run it now, out of schedule (the card's "Run now", or the run_scheduled_task tool). */
export async function runNow(id) {
  const routine = store.routines[id];
  if (!routine) return null;
  await fire(routine, { missed: false });
  return routine;
}

async function tick() {
  const now = Date.now();
  for (const routine of Object.values(store.routines)) {
    if (!routine.enabled || !routine.nextRunAt || routine.nextRunAt > now) continue;
    await fire(routine);
  }
}

async function catchUpMissed() {
  const now = Date.now();
  for (const routine of Object.values(store.routines)) {
    if (!routine.enabled || !routine.nextRunAt) continue;
    if (routine.nextRunAt > now) continue; // not due yet, nothing to catch up
    if (now - routine.nextRunAt <= MISSED_WINDOW_MS) {
      routine.missedAtStartup = true;
      await fire(routine, { missed: true });
    } else {
      // Missed by more than a day: skip it for good and just reschedule, per the spec.
      routine.nextRunAt = nextRun(routine.schedule.cron, new Date(now))?.getTime() ?? null;
      save();
    }
  }
}

export function stop() { clearInterval(timer); }
