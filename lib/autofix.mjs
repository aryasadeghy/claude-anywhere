// PR Auto-fix and auto-archive: two per-session switches in the PR menu, and the watcher
// behind both. Auto-fix wakes Claude in the session to fix what GitHub says is wrong with its
// pull request - failing checks, a merge conflict, a new review comment - the moment the
// session is free to hear it; auto-archive notices the pull request is done (merged or closed)
// and archives the session, the way Desktop's own auto-archive does.
//
// Flags live here, not in server.mjs's shared prefs.json: this module also owns the watcher
// that reads them, and a session gone from the sidebar (deleted) should not keep polling GitHub
// for it forever, which `forgetSession` below takes care of without server.mjs needing to know.

import fs from 'node:fs';
import path from 'node:path';
import { getSessionInfo, tagSession } from '@anthropic-ai/claude-agent-sdk';
import { isLive, isBusy, runs, startRun } from './runs.mjs';
import * as pr from './pr.mjs';

let FILE = null;
let autoFixOn = new Set();    // session ids
let autoArchiveOn = new Set();
let seen = {};                // session id -> fingerprint of the last failure already woken for
let timer = null;

export function init(dataDir) {
  FILE = path.join(dataDir, 'autofix.json');
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    autoFixOn = new Set(j.autoFix || []);
    autoArchiveOn = new Set(j.autoArchive || []);
    seen = j.seen || {};
  } catch { autoFixOn = new Set(); autoArchiveOn = new Set(); seen = {}; }
  clearInterval(timer);
  // "Every few minutes": often enough that a red check does not sit all afternoon, rare enough
  // that this never looks like it is hammering GitHub for sessions nobody is watching.
  timer = setInterval(() => { sweep().catch(() => {}); }, 3 * 60 * 1000);
  timer.unref?.();
}
function save() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ autoFix: [...autoFixOn], autoArchive: [...autoArchiveOn], seen })); } catch {} }

export const isAutoFix = (id) => autoFixOn.has(id);
export function setAutoFix(id, on) { if (on) autoFixOn.add(id); else { autoFixOn.delete(id); delete seen[id]; } save(); return isAutoFix(id); }
export const isAutoArchive = (id) => autoArchiveOn.has(id);
export function setAutoArchive(id, on) { if (on) autoArchiveOn.add(id); else autoArchiveOn.delete(id); save(); return isAutoArchive(id); }
export function forgetSession(id) { autoFixOn.delete(id); autoArchiveOn.delete(id); delete seen[id]; save(); }

// What is wrong right now, boiled into a short string so the same failure never wakes the
// session twice - a check still red five minutes later is not a new thing to fix, but a
// different check failing, or a comment arriving on top of it, is.
function trouble(p) {
  if (!p?.has) return null;
  const bits = [];
  if (p.checks?.failed) bits.push('checks:' + p.checks.failing.map((f) => f.name).sort().join(','));
  if (p.mergeState === 'DIRTY' || p.mergeable === 'CONFLICTING') bits.push('conflict');
  if (p.commentCount) bits.push('comments:' + p.commentCount);
  return bits.length ? bits.join('|') : null;
}

function prompt(p) {
  const lines = [`Auto-fix: #${p.number} (${p.url}) needs attention.`];
  if (p.checks?.failed) {
    lines.push('', 'Failing checks:');
    for (const f of p.checks.failing) lines.push('- ' + f.name + (f.url ? ' — ' + f.url : ''));
  }
  if (p.mergeState === 'DIRTY' || p.mergeable === 'CONFLICTING') lines.push('', 'This branch has a merge conflict with its base. Resolve it.');
  if (p.commentCount) {
    lines.push('', 'Review comments:');
    for (const c of p.inlineComments || []) lines.push(`- ${c.path}:${c.line} — ${c.author ? c.author + ': ' : ''}${c.body}`);
    for (const c of p.comments || []) if (!(p.inlineComments || []).some((i) => i.body === c.body)) lines.push(`- ${c.author ? c.author + ': ' : ''}${c.body}`);
  }
  lines.push('', 'Fix what is above, then commit and push.');
  return lines.join('\n');
}

async function wake(id, cwd, text) {
  if (isLive(id)) { runs.get(id).enqueue(text); return; }
  startRun({ sessionId: id, cwd, prompt: text });
}

async function sweep() {
  for (const id of new Set([...autoFixOn, ...autoArchiveOn])) {
    try {
      const info = await getSessionInfo(id).catch(() => null);
      if (!info?.cwd) continue;
      const p = await pr.cached(info.cwd);
      if (autoArchiveOn.has(id) && p?.has && (p.state === 'MERGED' || p.state === 'CLOSED')) {
        await tagSession(id, 'archived');
        forgetSession(id);
        continue;
      }
      if (!autoFixOn.has(id) || isBusy(id)) continue; // never interrupt a turn already under way
      const fp = trouble(p);
      if (!fp) { if (seen[id]) { delete seen[id]; save(); } continue; }
      if (seen[id] === fp) continue; // this exact failure already woke the session once
      seen[id] = fp; save();
      await wake(id, info.cwd, prompt(p));
    } catch {}
  }
}
