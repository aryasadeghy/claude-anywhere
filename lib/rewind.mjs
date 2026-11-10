// Desktop's "Redo rewind": a file restore is destructive (Query.rewindFiles overwrites the
// working tree in place), and the CLI's own checkpoints only ever point backward - there is no
// checkpoint for "the state right before this rewind" because nothing was about to edit those
// files. So this copies them itself, before the rewind, and can put them back once: "Undo works
// until you send your next message" (Desktop's own words) becomes "until the transcript grows",
// which lib/runs.mjs's `wroteSince` already uses the same way for a resting process.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { sessionFile } from './tail.mjs';

const ROOT = path.join(os.tmpdir(), 'claude-anywhere-rewind');
const redos = new Map(); // sessionId -> { dir, files: [{ abs, existed, backup }], sizeAtRewind, at }
const STALE_MS = 15 * 60 * 1000; // Desktop's own window is "until your next message"; this is the outer bound when none ever comes

function fileSize(sessionId) { try { const f = sessionFile(sessionId); return f ? fs.statSync(f).size : 0; } catch { return 0; } }

// Snapshot every file the upcoming rewind would touch, as it stands right now, so it can be put
// back. Call this right before the destructive rewindFiles(uuid, { dryRun: false }).
export function snapshot(sessionId, cwd, filesChanged) {
  const prev = redos.get(sessionId);
  if (prev) { try { fs.rmSync(prev.dir, { recursive: true, force: true }); } catch {} }
  const dir = path.join(ROOT, randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const files = (filesChanged || []).map((f, i) => {
    const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
    let existed = false;
    try { if (fs.statSync(abs).isFile()) { existed = true; fs.copyFileSync(abs, path.join(dir, String(i))); } } catch {}
    return { abs, existed, backup: path.join(dir, String(i)) };
  });
  redos.set(sessionId, { dir, files, sizeAtRewind: fileSize(sessionId), at: Date.now() });
}

// Nothing to redo, this redo has gone stale, or the conversation moved on since (a later message
// was taken into the transcript - the same signal a resting Run uses to tell "another window
// went on with this session").
export function canRedo(sessionId) {
  const e = redos.get(sessionId);
  if (!e) return false;
  if (Date.now() - e.at > STALE_MS) return false;
  return fileSize(sessionId) === e.sizeAtRewind;
}

export function redo(sessionId) {
  if (!canRedo(sessionId)) return false;
  const e = redos.get(sessionId);
  for (const f of e.files) {
    try { if (f.existed) fs.copyFileSync(f.backup, f.abs); else fs.rmSync(f.abs, { force: true }); } catch {}
  }
  redos.delete(sessionId);
  try { fs.rmSync(e.dir, { recursive: true, force: true }); } catch {}
  return true;
}

export function forget(sessionId) {
  const e = redos.get(sessionId);
  if (e) { try { fs.rmSync(e.dir, { recursive: true, force: true }); } catch {} }
  redos.delete(sessionId);
}
