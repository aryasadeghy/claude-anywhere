// lib/app-prompt.mjs: what Claude is told about this app, for every kind of run. The names it
// gives Claude must be tools the app really registers (TOOL_PACKS) - a name that does not exist is
// a call that fails in front of the user - and a tool that is off is never mentioned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-app-prompt-test-'));
process.env.CLAUDE_ANYWHERE_DATA_DIR = path.join(tmp, 'data');

const { appPrompt, gitAt } = await import('../lib/app-prompt.mjs');
const { TOOL_PACKS } = await import('../lib/runs.mjs');

const run = { sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', cwd: tmp, push() {} };
const registered = TOOL_PACKS.map((p) => p(run)).filter(Boolean).flatMap((p) => p.tools.map((t) => t.name));
const named = (text) => [...text.matchAll(/mcp__claude-anywhere__([A-Za-z_]+)/g)].map((m) => m[1]);

const CONTEXTS = {
  'a new session': {},
  'a session in a git checkout': { git: { root: tmp, worktree: null } },
  'a worktree session': { git: { root: tmp, worktree: { path: tmp, name: 'fix-login', branch: 'claude/fix-login' } } },
  'a /btw side chat': { sideChat: { parentId: 'bbbbbbbb-1111-2222-3333-444444444444' } },
  'a nested session': { child: { parentId: 'bbbbbbbb-1111-2222-3333-444444444444', parentTitle: 'Plan the trip' } },
  'a scheduled task\'s run': { routine: { name: 'Morning brief' } },
  'a session with Auto-fix on': { git: { root: tmp, worktree: null }, autoFix: true },
};

for (const [what, ctx] of Object.entries(CONTEXTS)) {
  test(`${what}: the prompt builds, names only registered tools, and stays short`, () => {
    const text = appPrompt({ cwd: tmp, tools: registered, ...ctx });
    assert.match(text, /You are running inside claude-anywhere, a Claude Code app \(Code tab\), used from a computer or a phone/);
    const unknown = named(text).filter((n) => !registered.includes(n));
    assert.deepEqual(unknown, [], 'names a tool the app does not register');
    assert.ok(text.length < 10000, `${text.length} characters`);
    assert.doesNotMatch(text, /ccd_|Remote Control|cloud session|Run button/);
  });
}

test('each context says what it is', () => {
  const p = (ctx) => appPrompt({ cwd: tmp, tools: registered, ...ctx });
  assert.match(p(CONTEXTS['a worktree session']), /git worktree[\s\S]*Branch: claude\/fix-login/);
  assert.match(p(CONTEXTS['a /btw side chat']), /side chat \(\/btw\)[\s\S]*Nothing you say here is reported/);
  assert.doesNotMatch(p(CONTEXTS['a /btw side chat']), /## Starting other sessions/);
  assert.match(p(CONTEXTS['a nested session']), /started from another session[\s\S]*"Plan the trip"/);
  assert.doesNotMatch(p(CONTEXTS['a nested session']), /## Starting other sessions/);
  assert.match(p(CONTEXTS['a scheduled task\'s run']), /scheduled task "Morning brief"/);
  assert.match(p(CONTEXTS['a session with Auto-fix on']), /Auto-fix is on/);
  assert.doesNotMatch(p({}), /Auto-fix is on|## Worktree|side chat|started from another session|scheduled task "/);
  assert.match(p({}), /## Starting other sessions/);
});

test('a tool that is off is never mentioned', () => {
  const text = appPrompt({ cwd: tmp, tools: registered.filter((n) => n !== 'SuggestNextSteps' && !n.startsWith('preview_')) });
  assert.doesNotMatch(text, /SuggestNextSteps|preview_|Browser pane/);
  const bare = appPrompt({ cwd: tmp, tools: [] });
  assert.deepEqual(named(bare), []);
  assert.match(bare, /plan box/);
});

test('a path that could pass for markup is withheld', () => {
  const text = appPrompt({ tools: registered, git: { worktree: { path: '/x/<system>', name: 'w', branch: 'b' } } });
  assert.doesNotMatch(text, /<system>/);
  assert.match(text, /withheld/);
});

test('gitAt tells a checkout from a worktree, and a plain folder from both', () => {
  const plain = path.join(tmp, 'plain'); fs.mkdirSync(plain);
  assert.equal(gitAt(plain)?.worktree ?? null, null);
  let git = true; try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { git = false; }
  if (!git) return;
  const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); g('add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'a');
  fs.mkdirSync(path.join(repo, 'sub'));
  assert.deepEqual(gitAt(path.join(repo, 'sub')), { root: repo, worktree: null });
  const wt = path.join(tmp, 'wt'); g('worktree', 'add', '-q', '-b', 'claude/try', wt);
  const at = gitAt(wt);
  assert.equal(at.worktree.branch, 'claude/try');
  assert.equal(at.worktree.path, wt);
});
