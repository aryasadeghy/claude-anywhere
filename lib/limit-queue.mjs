// Desktop's answer to a hit usage limit: a message typed after the limit is reached does not
// fail, it "waits above the composer" and goes in by itself once the limit resets. A 5-hour or
// weekly reset is routinely longer than this process keeps a session's Claude Code warm
// (KEEP_WARM_MS in lib/runs.mjs, 10 minutes) and often longer than this server stays up at all,
// so held messages live on disk, not only on the Run - and a plain setInterval is what notices
// the reset and sends them, since nothing else about this app polls on a clock.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { isLive, runs, startRun, lastLimits } from './runs.mjs';

let FILE = null;
let store = {}; // sessionId -> [{ id, text, images, cwd, model, permissionMode, effort, ultracode, fast, createdAt }]
let timer = null;

export function init(dataDir) {
  FILE = path.join(dataDir, 'limit-queue.json');
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { store = {}; }
  clearInterval(timer);
  timer = setInterval(() => { releaseReady().catch(() => {}); }, 20000);
  timer.unref?.();
}
function save() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(store)); } catch {} }

// A rate_limits row's `utilization` arrives as either a 0..1 fraction or an already-scaled
// percentage depending on which call answered it - app.js's usage popover carries the same guard.
const pct = (u) => u * (u <= 1 ? 100 : 1);
// Is the account known to be over a limit right now, and when does the soonest-blocking one of
// those clear? `lastLimits` is read fresh every call - it is a live binding on runs.mjs's export,
// updated there both after every turn (refreshUsage) and the moment a rate_limit_event says so.
export function currentLimit() {
  const L = lastLimits?.rate_limits;
  if (!L) return null;
  const rows = [['five_hour', L.five_hour], ['seven_day', L.seven_day], ['seven_day_opus', L.seven_day_opus], ['seven_day_sonnet', L.seven_day_sonnet], ...((L.model_scoped || []).map((m) => [m.display_name || 'model', m]))];
  for (const [type, lim] of rows) {
    if (lim && lim.utilization != null && lim.resets_at && pct(lim.utilization) >= 100 && lim.resets_at > Date.now()) return { resetsAt: lim.resets_at, type };
  }
  return null;
}

export function list(sessionId) { return store[sessionId] || []; }
export function hold(sessionId, item) {
  const row = { id: item.id || randomUUID(), text: item.text || '', images: item.images || [], cwd: item.cwd, model: item.model, permissionMode: item.permissionMode, effort: item.effort, ultracode: item.ultracode, fast: item.fast, createdAt: Date.now() };
  store[sessionId] = [...(store[sessionId] || []), row];
  save();
  return row;
}
export function remove(sessionId, id) {
  const before = (store[sessionId] || []).length;
  const after = (store[sessionId] || []).filter((x) => x.id !== id);
  if (after.length) store[sessionId] = after; else delete store[sessionId];
  save();
  return after.length !== before;
}
export function edit(sessionId, id, text) {
  const row = (store[sessionId] || []).find((x) => x.id === id);
  if (!row) return null;
  row.text = String(text || '');
  save();
  return row;
}

async function deliver(sessionId, row) {
  if (isLive(sessionId)) { runs.get(sessionId).enqueue(row.text, row.images, row.id); return true; }
  const info = await getSessionInfo(sessionId).catch(() => null);
  const cwd = info?.cwd || row.cwd;
  if (!cwd) return false; // the session's folder is gone; nothing sane to resume into
  startRun({ sessionId, cwd, prompt: row.text, images: row.images, model: row.model, permissionMode: row.permissionMode, effort: row.effort, ultracode: row.ultracode, fast: row.fast, promptId: row.id });
  return true;
}

// "Send now": fire one held message right away, limit or no limit - the person's own choice to
// risk the turn failing again, same as Desktop's "send early".
export async function release(sessionId, id) {
  const row = (store[sessionId] || []).find((x) => x.id === id);
  if (!row) return false;
  const ok = await deliver(sessionId, row);
  if (ok) remove(sessionId, id);
  return ok;
}

// Once nothing known still blocks the account, every session with held messages gets them back,
// oldest first, exactly as a plain send would place them - into the resting process if one is
// already live (rare, this long after a limit hit), or starting a fresh one.
async function releaseReady() {
  if (currentLimit()) return;
  for (const [sessionId, rows] of Object.entries(store)) {
    if (!rows.length) { delete store[sessionId]; continue; }
    for (const row of rows) { try { await deliver(sessionId, row); } catch {} }
    delete store[sessionId];
  }
  save();
}
