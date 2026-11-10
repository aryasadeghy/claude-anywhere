// Per-session git worktrees. A worktree is a second checkout of the same repository
// on its own branch, so a session can work on something without disturbing what is
// open in the editor on the main checkout.
//
// Ours go *beside* the repository, never inside it: a worktree within the tree
// confuses every tool that walks the project, starting with git itself.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const execFileP = promisify(execFile);

export const gitOut = (cwd, args, timeout = 15000) =>
  execFileP('git', ['-C', cwd, ...args], { timeout, windowsHide: true }).then((r) => r.stdout.trim());

/** The last line git or gh printed, which is the part that says what went wrong. */
export const cliError = (e) => String(e.stderr || e.message || e).trim().split('\n').filter(Boolean).slice(-1)[0] || 'the command refused';

export const sameDir = (a, b) =>
  path.normalize(String(a || '')).replace(/[\\/]+$/, '').toLowerCase() === path.normalize(String(b || '')).replace(/[\\/]+$/, '').toLowerCase();

/** Where a worktree for `branch` of the repository at `root` belongs. */
export const worktreePath = (root, branch) =>
  path.join(path.dirname(root), path.basename(root) + '-worktrees', branch.replace(/[/]/g, '-'));

/** Every checkout git knows about for this repository, ours marked. */
export async function listFor(cwd, mine = []) {
  const root = await gitOut(cwd, ['rev-parse', '--show-toplevel']);
  const out = await gitOut(cwd, ['worktree', 'list', '--porcelain']);
  const worktrees = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: path.normalize(line.slice(9).trim()), branch: '' }; worktrees.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace('refs/heads/', '');
    else if (line.startsWith('detached')) cur.branch = '(detached)';
  }
  return {
    root,
    worktrees: worktrees.map((w) => ({
      ...w,
      main: sameDir(w.path, root),
      ours: mine.some((m) => sameDir(m.path, w.path)),
      gone: !fs.existsSync(w.path),
    })),
  };
}

const VALID_BRANCH = /^[A-Za-z0-9._/-]{1,80}$/;

/**
 * Add a worktree for `branch`. An existing branch is checked out there; a new name is
 * created from the current HEAD. Returns { path, branch, repo, existed }.
 */
export async function add(cwd, branch) {
  const name = String(branch || '').trim();
  if (!VALID_BRANCH.test(name) || name.includes('..') || name.endsWith('/') || name.endsWith('.lock')) {
    throw Object.assign(new Error('Branch names here can use letters, numbers, dot, dash and slash.'), { status: 400 });
  }
  const root = await gitOut(cwd, ['rev-parse', '--show-toplevel']);
  const dir = worktreePath(root, name);
  if (fs.existsSync(dir)) throw Object.assign(new Error('There is already a folder at ' + dir), { status: 409 });
  // `--verify --quiet` exits non-zero for an unknown ref, which is how we tell new from existing.
  const existed = await gitOut(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + name]).catch(() => '');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const args = existed ? ['worktree', 'add', dir, name] : ['worktree', 'add', '-b', name, dir];
  // A first worktree on a big repository copies the whole tree: minutes, not seconds.
  await execFileP('git', ['-C', root, ...args], { timeout: 300000, windowsHide: true });
  return { path: dir, branch: name, repo: root, existed: !!existed };
}

/** Remove a worktree we made. The branch itself stays. */
export async function remove(known, { force = false } = {}) {
  await execFileP('git', ['-C', known.repo, 'worktree', 'remove', ...(force ? ['--force'] : []), known.path], { timeout: 120000, windowsHide: true });
}

// ---------- a worktree made for a new session: a branch named from the first message ----------

// Filler words left out of a branch slug - what is left is the part someone would actually
// read to tell one branch from another at a glance.
const STOPWORDS = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'is', 'are', 'be', 'this', 'that', 'with', 'please', 'can', 'you', 'it', 'me', 'my', 'i', 'we', 'our', 'your', 'then', 'into', 'so', 'as', 'from', 'up', 'do']);

/** A descriptive branch name from a session's first message - the "claude/" prefix this file's
 * own manual worktree flow already uses, a few significant words slugged, and a short random
 * suffix so two sessions that open with a similar sentence never collide. */
export function branchFromMessage(message) {
  const words = String(message || '')
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ') // a code span is noise here, not a description
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w));
  const slug = words.slice(0, 6).join('-').slice(0, 50).replace(/-+$/, '');
  return `claude/${slug || 'session'}-${randomBytes(2).toString('hex')}`;
}

/** `.worktreeinclude` at the repository root: a gitignore-style list of paths (one per line,
 * `#` comments and blank lines skipped, a trailing `/` just cosmetic for a directory) that a
 * fresh worktree should get copies of - the files `.gitignore` keeps out of every checkout,
 * `.env` foremost, which a plain `git worktree add` therefore never has either. */
export function readWorktreeInclude(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, '.worktreeinclude'), 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** Copy every `.worktreeinclude` entry that exists in `root` into `dir`, skipping one already
 * there (a tracked file the checkout already carries). Returns the relative paths it copied. */
export function copyIncluded(root, dir, patterns) {
  const copied = [];
  for (const raw of patterns) {
    const rel = raw.replace(/\/$/, '');
    if (!rel || rel.includes('..')) continue;
    const src = path.join(root, rel), dest = path.join(dir, rel);
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    copied.push(rel);
  }
  return copied;
}

// An always-empty hooks directory: `-c core.hooksPath=` pointed at it is how a single `git`
// call skips every hook - here, specifically `post-checkout` - without touching the
// repository's real `.git/hooks` or any config that would outlive this one command.
const NO_HOOKS_DIR = path.join(os.tmpdir(), 'claude-anywhere-no-hooks');

/**
 * A worktree for a brand-new session: a descriptive branch from its first message, no
 * `post-checkout` hook (nothing has "checked out" on the person's own behalf here), and
 * `.worktreeinclude` files copied over since a fresh checkout never has them. `signal` cancels
 * the `git worktree add` itself - see `abandon` for cleaning up after that.
 */
export async function addForSession(cwd, message, { signal } = {}) {
  const root = await gitOut(cwd, ['rev-parse', '--show-toplevel']);
  const branch = branchFromMessage(message);
  const dir = worktreePath(root, branch);
  if (fs.existsSync(dir)) throw Object.assign(new Error('There is already a folder at ' + dir), { status: 409 });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(NO_HOOKS_DIR, { recursive: true });
  try {
    await execFileP('git', ['-C', root, '-c', 'core.hooksPath=' + NO_HOOKS_DIR, 'worktree', 'add', '-b', branch, dir], { timeout: 300000, windowsHide: true, signal });
  } catch (e) {
    // A Stop mid-add (or any other failure here) may still have left a half-made worktree on
    // disk - root/dir travel with the error so the caller's cleanup (`abandon`) knows where.
    throw Object.assign(e, { root, dir });
  }
  const copied = copyIncluded(root, dir, readWorktreeInclude(root));
  return { path: dir, branch, repo: root, copied };
}

/** Best-effort cleanup after `addForSession` was cancelled or failed partway: remove whatever
 * directory git left, and let git forget the worktree it half-registered. */
export async function abandon(root, dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  try { await execFileP('git', ['-C', root, 'worktree', 'prune'], { timeout: 15000, windowsHide: true }); } catch {}
}
