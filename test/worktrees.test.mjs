// The pure-logic half of a new session's own worktree (lib/worktrees.mjs): a branch name
// derived from the first message, and which `.worktreeinclude` entries get copied - no git
// process involved, so this runs in milliseconds rather than through a browser.
// `node --test test/worktrees.test.mjs` (not wired into `npm test` - the integrator does that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { branchFromMessage, readWorktreeInclude, copyIncluded } from '../lib/worktrees.mjs';

test('branchFromMessage: a few significant words, slugged, under claude/', () => {
  const b = branchFromMessage('Please fix the login button that does not respond on mobile Safari');
  assert.match(b, /^claude\/fix-login-button-does-not-respond-[0-9a-f]{4}$/);
});

test('branchFromMessage: stopwords and code spans do not make it into the slug', () => {
  const b = branchFromMessage('Can you run `npm test` and fix the output');
  assert.doesNotMatch(b, /npm|test|-and-|-the-/);
  assert.match(b, /^claude\/run-fix-output-[0-9a-f]{4}$/);
});

test('branchFromMessage: an empty or all-stopword message still gets a usable name', () => {
  assert.match(branchFromMessage(''), /^claude\/session-[0-9a-f]{4}$/);
  assert.match(branchFromMessage('the of and'), /^claude\/session-[0-9a-f]{4}$/);
});

test('branchFromMessage: two calls never collide even for the same message', () => {
  const a = branchFromMessage('add dark mode');
  const b = branchFromMessage('add dark mode');
  assert.notEqual(a, b);
});

test('readWorktreeInclude: comments and blank lines are skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-wt-test-'));
  fs.writeFileSync(path.join(root, '.worktreeinclude'), '# secrets\n.env\n\n.env.local\n  \nconfig/local.json\n');
  assert.deepEqual(readWorktreeInclude(root), ['.env', '.env.local', 'config/local.json']);
});

test('readWorktreeInclude: no file at all is an empty list, not an error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-wt-test-'));
  assert.deepEqual(readWorktreeInclude(root), []);
});

test('copyIncluded: copies a listed file and a listed directory that exist, skips one that does not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-wt-test-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-wt-test-'));
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', 'local.json'), '{}');
  const copied = copyIncluded(root, dir, ['.env', 'config/', 'missing.txt']);
  assert.deepEqual(copied.sort(), ['.env', 'config']);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'SECRET=1\n');
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'local.json'), 'utf8'), '{}');
});

test('copyIncluded: a file already present in the worktree (no longer gitignored) is left alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-wt-test-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-wt-test-'));
  fs.writeFileSync(path.join(root, '.env'), 'from-root\n');
  fs.writeFileSync(path.join(dir, '.env'), 'already-tracked\n');
  assert.deepEqual(copyIncluded(root, dir, ['.env']), []);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'already-tracked\n');
});

test('copyIncluded: a `..` entry is refused rather than copied from outside the repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-wt-test-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-wt-test-'));
  assert.deepEqual(copyIncluded(root, dir, ['../secrets.txt']), []);
});
