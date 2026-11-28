// The decisions behind "Relaunch to update": is a release newer, can a git checkout move to it,
// does the download resume and refuse a short file. Real git repositories in a temp folder (an
// "origin" and a clone of it), a real HTTP server for the installer - nothing from the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { newer, versionOf, assetFor } from '../lib/update.mjs';
import { isCheckout, checkoutInfo, planCheckout, applyCheckout, notesHead, downloadAsset } from '../lib/updater.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-updater-'));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).trim();
const write = (dir, f, text) => fs.writeFileSync(path.join(dir, f), text);

test('newer: only a higher release counts, and a pre-release sorts before its release', () => {
  assert.equal(newer('0.15.0', '0.14.3'), true);
  assert.equal(newer('0.14.3', '0.14.3'), false);
  assert.equal(newer('0.14.2', '0.14.3'), false);
  assert.equal(newer('0.15.0-beta.1', '0.15.0'), false);
  assert.equal(newer('0.15.0', '0.15.0-beta.1'), true);
  assert.equal(versionOf('v1.2.3'), '1.2.3');
  assert.equal(versionOf('nightly'), '');
  assert.equal(assetFor([{ name: 'a.dmg' }, { name: 'a-setup.exe', browser_download_url: 'u', size: 5 }], 'win32').name, 'a-setup.exe');
  assert.equal(assetFor([{ name: 'a.dmg' }], 'win32'), null);
});

test('notesHead: the first lines, without markdown', () => {
  assert.deepEqual(notesHead('## What changed\n\n- **Added** a `thing`\n- Fixed it\n', 2), ['What changed', 'Added a thing']);
});

// origin has v0.1.0 then v0.2.0; the clone starts at v0.1.0.
function makeRepos() {
  const origin = fs.mkdtempSync(path.join(tmp, 'origin-'));
  git(origin, 'init', '-q', '-b', 'main');
  write(origin, 'package.json', '{"version":"0.1.0"}'); write(origin, 'package-lock.json', 'one');
  git(origin, 'add', '-A'); git(origin, 'commit', '-qm', 'one'); git(origin, 'tag', 'v0.1.0');
  const clone = path.join(fs.mkdtempSync(path.join(tmp, 'clone-')), 'app');
  execFileSync('git', ['clone', '-q', origin, clone]);
  write(origin, 'package.json', '{"version":"0.2.0"}'); write(origin, 'package-lock.json', 'two');
  git(origin, 'commit', '-qam', 'two'); git(origin, 'tag', 'v0.2.0');
  git(clone, 'fetch', '-q', 'origin', '--tags');
  return { origin, clone };
}

test('checkout: detected by .git; package-lock.json alone is not a dirty checkout', () => {
  const { clone } = makeRepos();
  assert.equal(isCheckout(clone), true);
  assert.equal(isCheckout(tmp), false);
  write(clone, 'package-lock.json', 'edited by npm');
  const info = checkoutInfo(clone);
  assert.equal(info.branch, 'main');
  assert.deepEqual(info.dirty, []);
  assert.equal(info.lockDirty, true);
  assert.equal(planCheckout(clone, 'v0.2.0').ok, true);
});

test('checkout: a fast-forward is planned, and says whether dependencies moved', () => {
  const { clone } = makeRepos();
  const p = planCheckout(clone, 'v0.2.0');
  assert.equal(p.ok, true);
  assert.equal(p.lockChanged, true);
  assert.match(p.commit, /^[0-9a-f]{40}$/);
});

test('checkout: refused with a reason when off main, dirty, diverged, or the tag is missing', () => {
  const { clone } = makeRepos();
  assert.match(planCheckout(clone, 'v9.9.9').reason, /not on origin/);
  write(clone, 'notes.txt', 'x'); git(clone, 'add', 'notes.txt');
  assert.match(planCheckout(clone, 'v0.2.0').reason, /uncommitted changes \(notes.txt\)/);
  git(clone, 'commit', '-qm', 'local work');
  assert.match(planCheckout(clone, 'v0.2.0').reason, /cannot be fast-forwarded/);
  git(clone, 'checkout', '-q', '-b', 'topic');
  assert.match(planCheckout(clone, 'v0.2.0').reason, /on topic/);
});

test('checkout: applying moves HEAD to the tag, drops the local lock edit, and never merges a diverged branch', async () => {
  const { clone, origin } = makeRepos();
  write(clone, 'package-lock.json', 'edited by npm');
  const r = await applyCheckout(clone, 'v0.2.0', { install: false });
  assert.equal(r.installed, false);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'v0.2.0^{commit}'));
  assert.equal(fs.readFileSync(path.join(clone, 'package-lock.json'), 'utf8'), 'two');
  assert.match(planCheckout(clone, 'v0.2.0').reason, /Already at/);
  const b = makeRepos();
  write(b.clone, 'mine.txt', '1'); git(b.clone, 'add', '-A'); git(b.clone, 'commit', '-qm', 'mine');
  const before = git(b.clone, 'rev-parse', 'HEAD');
  await assert.rejects(applyCheckout(b.clone, 'v0.2.0', { install: false }), /cannot be fast-forwarded/);
  assert.equal(git(b.clone, 'rev-parse', 'HEAD'), before);
});

// ---------- the download ----------
function serve(body, { range = true } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.headers.range || '');
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    if (range && m) { const from = Number(m[1]); res.writeHead(206, { 'content-length': body.length - from }); return res.end(body.subarray(from)); }
    res.writeHead(200, { 'content-length': body.length }); res.end(body);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}/x-setup.exe`, hits, close: () => srv.close() })));
}

test('download: a partial file is resumed, and only a complete one gets the real name', async () => {
  const body = Buffer.from('0123456789'.repeat(1000));
  const s = await serve(body);
  const dir = fs.mkdtempSync(path.join(tmp, 'dl-'));
  fs.writeFileSync(path.join(dir, 'x-setup.exe.part'), body.subarray(0, 4000));
  const seen = [];
  const file = await downloadAsset({ name: 'x-setup.exe', url: s.url, size: body.length }, dir, (g, t) => seen.push([g, t]));
  assert.equal(fs.readFileSync(file).equals(body), true);
  assert.deepEqual(s.hits, ['bytes=4000-']);
  assert.equal(fs.existsSync(file + '.part'), false);
  assert.equal(seen.at(-1)[0], body.length);
  s.close();
});

test('download: a server that ignores Range cannot corrupt the file', async () => {
  const body = Buffer.from('abcdefghij'.repeat(500));
  const s = await serve(body, { range: false });
  const dir = fs.mkdtempSync(path.join(tmp, 'dl-'));
  fs.writeFileSync(path.join(dir, 'x-setup.exe.part'), body.subarray(0, 1000));
  const file = await downloadAsset({ name: 'x-setup.exe', url: s.url, size: body.length }, dir);
  assert.equal(fs.readFileSync(file).equals(body), true);
  s.close();
});

test('download: a short file is never given the real name', async () => {
  const body = Buffer.from('z'.repeat(2000));
  const s = await serve(body);
  const dir = fs.mkdtempSync(path.join(tmp, 'dl-'));
  await assert.rejects(downloadAsset({ name: 'x-setup.exe', url: s.url, size: 5000 }, dir), /stopped at 2000 of 5000/);
  assert.equal(fs.existsSync(path.join(dir, 'x-setup.exe')), false);
  assert.equal(fs.existsSync(path.join(dir, 'x-setup.exe.part')), true);
  s.close();
});
