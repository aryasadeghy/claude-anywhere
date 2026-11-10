// "@"'s file picker: every file in a folder, fuzzy-ranked the way typing a few letters of a
// name should read. `git ls-files --cached --others --exclude-standard` is cheap and already
// respects .gitignore; a folder git does not know (no repository yet) falls back to a capped,
// breadth-first walk so the picker still works there, just without the ignore rules.
// Dotfiles are not filtered out, unlike the folder browser - Desktop's own picker shows them.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
const execFileP = promisify(execFile);

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.venv', '__pycache__']);
const WALK_CAP = 20000; // files looked at, not files returned - keeps a huge non-git folder quick

async function viaGit(cwd) {
  const r = await execFileP('git', ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard'], { timeout: 8000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

// Breadth-first, so a cap favours files near the root over exhausting one deep subtree first.
function viaWalk(cwd) {
  const out = [];
  const queue = [''];
  while (queue.length && out.length < WALK_CAP) {
    const rel = queue.shift();
    let entries;
    try { entries = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) queue.push(r);
      else out.push(r);
      if (out.length >= WALK_CAP) break;
    }
  }
  return out;
}

async function listFiles(cwd) {
  try { const files = await viaGit(cwd); if (files.length) return files; } catch {}
  return viaWalk(cwd);
}

// basename-prefix beats basename-substring beats anywhere-in-the-path beats a subsequence -
// typing "idx" should find src/index.js before it finds src/i-d-o-n-t-x-ist.js.
function score(q, rel) {
  const base = rel.split(/[\\/]/).pop().toLowerCase();
  const low = rel.toLowerCase();
  if (base.startsWith(q)) return 300 - Math.min(base.length, 100);
  if (base.includes(q)) return 200 - base.indexOf(q);
  if (low.includes(q)) return 100 - low.indexOf(q);
  let last = -1, hit = 0;
  for (const ch of q) { const i = low.indexOf(ch, last + 1); if (i < 0) return -1; hit++; last = i; }
  return hit; // present, in order, just scattered - the weakest of the four
}

export async function search(cwd, q, { limit = 60 } = {}) {
  const files = await listFiles(cwd);
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return files.sort().slice(0, limit);
  return files.map((f) => ({ f, s: score(needle, f) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s || a.f.length - b.f.length).slice(0, limit).map((x) => x.f);
}
