// Which Claude Code this computer runs, and taking a newer one without waiting for a release.
//
// The SDK carries Claude Code as a native binary in a package of its own per platform
// (@anthropic-ai/claude-agent-sdk-win32-x64 and so on), so the app's Claude Code was as old as
// the app: a new model, or a fix Desktop already shipped, waited for the SDK bump, a release
// and an update. Asked for in Settings, this fetches that platform package at its newest
// version from npm, checks it against npm's own checksum, takes the binary out, makes sure it
// starts, and points every query() at it (`pathToClaudeCodeExecutable`). The SDK's JavaScript
// stays as shipped; it drives newer Claude Codes the way Desktop's does.
//
// The binary is kept in DATA_DIR/claude-code/, named in current.json. Whichever is newer wins,
// the download or the one the app came with, so an app update that carries a newer Claude
// Code goes back to its own without being asked.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { newer } from './update.mjs';

const require = createRequire(import.meta.url);
const SDK = '@anthropic-ai/claude-agent-sdk';
const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';
// npm's own variable, so a mirror set for npm is the one asked here too.
const registry = () => (process.env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/+$/, '');
const FRESH_FOR = 5 * 60 * 1000;
const STALL_MS = 60 * 1000;

const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'manifest.json');
// Read each time, not once: `npm install` under a running server changes the binary new
// processes start with, and the version has to follow it.
export const bundledVersion = () => { try { return JSON.parse(fs.readFileSync(manifest, 'utf8')).version || ''; } catch { return ''; } };

// The SDK's own search (XW in sdk.mjs): on Linux, the musl build first on a musl system.
let keys = null;
function candidates() {
  if (keys) return keys;
  const p = process.platform, a = process.arch;
  if (p !== 'linux') return (keys = [`${p}-${a}`]);
  const musl = !process.report?.getReport?.()?.header?.glibcVersionRuntime;
  return (keys = musl ? [`linux-${a}-musl`, `linux-${a}`] : [`linux-${a}`, `linux-${a}-musl`]);
}
// The binary the SDK starts when it is given none, and the platform package it came in.
export function bundled() {
  for (const key of candidates()) { try { return { key, file: require.resolve(`${SDK}-${key}/${EXE}`) }; } catch {} }
  return { key: candidates()[0], file: '' };
}

let dir = '';
let current = null; // { version, sdk, file, at } - a downloaded Claude Code, when there is one
let latest = { at: 0, version: '', sdk: '', error: '' };
let checking = null;
let job = null;     // { version, phase: 'download' | 'unpack' | 'check' | 'done' | 'failed', got, total, error, at, dir }
const listeners = new Set();

const usable = (c) => !!c?.version && newer(c.version, bundledVersion()) && fs.existsSync(c.file);
export const version = () => (usable(current) ? current.version : bundledVersion());
// Spread into every query(): without it the SDK starts the app's own, older Claude Code.
export const spawnOptions = () => (usable(current) ? { pathToClaudeCodeExecutable: current.file } : {});
// Told when the Claude Code that new processes start has changed.
export const onChange = (fn) => { listeners.add(fn); };
const changed = () => { for (const fn of listeners) { try { fn(version()); } catch {} } };

export function useDir(d) {
  dir = d;
  try { current = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')); } catch { current = null; }
  if (current && !usable(current)) forget();
  tidy();
}
function forget() {
  current = null;
  try { fs.rmSync(path.join(dir, 'current.json'), { force: true }); } catch {}
}
// Everything in the folder but the binary in use and a download under way: older versions, a
// half-written one. Windows will not delete a binary a process still runs; that one goes the
// next time.
function tidy() {
  let names = []; try { names = fs.readdirSync(dir); } catch { return; }
  const keep = new Set(['current.json']);
  if (current) keep.add(path.basename(path.dirname(current.file)));
  if (job?.dir && !['done', 'failed'].includes(job.phase)) { keep.add(path.basename(job.dir)); keep.add(path.basename(job.dir) + '.tgz'); }
  for (const n of names) if (!keep.has(n)) { try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch {} }
}

export function status() {
  const v = version();
  return {
    version: v, bundled: bundledVersion(), using: usable(current) ? 'download' : 'bundled',
    latest: latest.version, sdk: latest.sdk, checkedAt: latest.at || null, error: latest.error,
    newer: !!latest.version && newer(latest.version, v),
    job: job && { version: job.version, phase: job.phase, got: job.got, total: job.total, error: job.error, at: job.at },
  };
}

const enc = (name) => name.replace('/', '%2f');
async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('npm answered ' + r.status);
  return r.json();
}

// Which Claude Code the newest SDK carries: npm keeps the SDK's `claudeCodeVersion` beside it.
export function check({ force = false } = {}) {
  if (!force && Date.now() - latest.at < FRESH_FOR) return Promise.resolve(status());
  checking ??= (async () => {
    try {
      const j = await getJson(`${registry()}/${enc(SDK)}/latest`);
      latest = { at: Date.now(), sdk: j.version || '', version: j.claudeCodeVersion || '', error: j.claudeCodeVersion ? '' : 'npm did not say which Claude Code ' + (j.version || 'the newest SDK') + ' carries' };
    } catch (e) {
      latest = { ...latest, at: Date.now(), error: e?.name === 'TimeoutError' ? 'npm did not answer' : String(e?.message || e) };
    } finally { checking = null; }
    return status();
  })();
  return checking;
}

export function update() {
  if (job && !['done', 'failed'].includes(job.phase)) return status(); // already on its way
  if (!dir) throw Object.assign(new Error('There is no folder to keep it in.'), { status: 500 });
  if (!latest.version || !newer(latest.version, version())) throw Object.assign(new Error('There is nothing newer than ' + version() + ' to take.'), { status: 400 });
  const j = job = { version: latest.version, sdk: latest.sdk, phase: 'download', got: 0, total: 0, error: '', at: Date.now(), dir: path.join(dir, latest.version + '-' + Date.now().toString(36)) };
  take(j).then(() => { j.phase = 'done'; changed(); }, (e) => {
    j.phase = 'failed';
    j.error = e?.name === 'AbortError' ? 'The download stopped moving for a minute' : String(e?.message || e);
  }).finally(tidy);
  return status();
}

// Back to the Claude Code the app came with. Its download goes too, unless a process still runs it.
export function useBundled() {
  if (!current) return status();
  forget(); changed(); tidy();
  return status();
}

async function take(j) {
  const { key } = bundled(), pkg = `${SDK}-${key}`;
  const meta = await getJson(`${registry()}/${enc(pkg)}/${j.sdk}`);
  const url = meta?.dist?.tarball, integrity = meta?.dist?.integrity || '';
  if (!url || !integrity.startsWith('sha512-')) throw new Error(`npm has no ${key} build of Claude Code ${j.version}`);
  fs.mkdirSync(j.dir, { recursive: true });
  const tgz = j.dir + '.tgz';
  try {
    // A connection that goes quiet is given up on; a slow one is not.
    const abort = new AbortController();
    let stall = setTimeout(() => abort.abort(), STALL_MS);
    const r = await fetch(url, { signal: abort.signal });
    if (!r.ok || !r.body) throw new Error('npm answered ' + r.status + ' for the download');
    j.total = Number(r.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha512');
    const count = new Transform({ transform(chunk, _e, cb) { hash.update(chunk); j.got += chunk.length; clearTimeout(stall); stall = setTimeout(() => abort.abort(), STALL_MS); cb(null, chunk); } });
    try { await pipeline(Readable.fromWeb(r.body), count, fs.createWriteStream(tgz)); } finally { clearTimeout(stall); }
    if ('sha512-' + hash.digest('base64') !== integrity) throw new Error("The download did not match npm's checksum, so it was thrown away");
    j.phase = 'unpack';
    const file = path.join(j.dir, EXE);
    await unpackOne(tgz, 'package/' + EXE, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
    j.phase = 'check';
    await says(file);
    current = { version: j.version, sdk: j.sdk, file, at: Date.now() };
    fs.writeFileSync(path.join(dir, 'current.json.tmp'), JSON.stringify(current, null, 2));
    fs.renameSync(path.join(dir, 'current.json.tmp'), path.join(dir, 'current.json'));
  } finally { fs.rmSync(tgz, { force: true }); }
}

// It has to start here before anything runs on it: an antivirus that quarantines it, or a
// build for the wrong libc, fails now and leaves the old one in use.
function says(file) {
  return new Promise((resolve, reject) => {
    execFile(file, ['--version'], { timeout: 60000, windowsHide: true, env: { ...process.env, DISABLE_AUTOUPDATER: '1' } }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim();
      if (!err && /\d+\.\d+\.\d+/.test(out)) return resolve(out);
      const why = String(stderr || err?.message || '').trim().split('\n')[0].slice(0, 200);
      reject(new Error('The new Claude Code did not start' + (why ? ': ' + why : '')));
    });
  });
}

// npm's tarballs are gzipped tar: a 512-byte header before each file, its bytes padded to 512.
// Only the binary is wanted, so this reads headers and writes that one file out.
async function unpackOne(tgz, wanted, dest) {
  let fd = null, found = false, state = 'head', need = 512, part = [], entry = null, next = {};
  const endBody = () => {
    if (fd !== null) { fs.closeSync(fd); fd = null; found = true; state = 'end'; return; }
    const pad = entry.padded - entry.size;
    if (pad) { state = 'pad'; need = pad; } else { state = 'head'; need = 512; }
  };
  const sink = new Writable({
    write(chunk, _e, cb) {
      try {
        for (let i = 0; i < chunk.length && state !== 'end';) {
          const n = Math.min(need, chunk.length - i), piece = chunk.subarray(i, i + n);
          i += n; need -= n;
          if (state === 'body') { if (fd !== null) fs.writeSync(fd, piece); } else if (state !== 'pad') part.push(piece);
          if (need) continue;
          if (state === 'head') {
            const h = Buffer.concat(part); part = [];
            if (h.every((b) => b === 0)) { state = 'end'; break; }
            const field = (a, b) => h.toString('utf8', a, b).replace(/\0[\s\S]*$/, '');
            const prefix = h.toString('latin1', 257, 262) === 'ustar' ? field(345, 500) : '';
            const name = next.path ?? (prefix ? prefix + '/' : '') + field(0, 100);
            const size = next.size ?? (parseInt(field(124, 136).trim() || '0', 8) || 0);
            const type = h[156] ? String.fromCharCode(h[156]) : '0';
            next = {};
            entry = { size, padded: Math.ceil(size / 512) * 512 };
            if (type === 'x') { state = 'pax'; need = entry.padded; continue; } // what it says applies to the next file
            if ((type === '0' || type === '\0') && name === wanted) fd = fs.openSync(dest, 'w');
            state = 'body'; need = size;
            if (!need) endBody();
          } else if (state === 'pax') {
            for (const line of Buffer.concat(part).subarray(0, entry.size).toString('utf8').split('\n')) {
              const m = line.match(/^\d+ (\w+)=(.*)$/);
              if (m?.[1] === 'path') next.path = m[2];
              if (m?.[1] === 'size') next.size = Number(m[2]);
            }
            part = []; state = 'head'; need = 512;
          } else if (state === 'body') endBody();
          else { state = 'head'; need = 512; }
        }
        cb();
      } catch (e) { cb(e); }
    },
  });
  try { await pipeline(fs.createReadStream(tgz), zlib.createGunzip(), sink); }
  finally { if (fd !== null) fs.closeSync(fd); }
  if (!found) { fs.rmSync(dest, { force: true }); throw new Error(`The package has no ${wanted.replace(/^package\//, '')} in it`); }
}
