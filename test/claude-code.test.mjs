// Settings › Claude Code, end to end on the server: the real app asks a stand-in npm registry
// for the newest Claude Code, downloads it, checks it, and starts it for every new process from
// then on. The "newer" one is the Claude Code the app came with, repackaged as 2.1.999, so a turn
// on it is real (against the fake Anthropic API). No network, nothing to install: `node --test test/`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { freePort, startApp, startFakeApi, fakeApiEnv, startFakeRegistry } from './fixtures/index.mjs';

let tmp, app, api, registry, cc, own, dataDir;
const call = async (p, opts = {}) => { const r = await fetch(app.base + '/api' + p, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + app.token } }); return { status: r.status, body: await r.json() }; };
const post = (p, body = {}) => call(p, { method: 'POST', body: JSON.stringify(body) });
const until = async (fn, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); } return null; };
const finished = () => until(async () => { const s = (await call('/claude-code')).body; return ['done', 'failed'].includes(s.job?.phase) && s; });
const folder = () => { try { return fs.readdirSync(path.join(dataDir, 'claude-code')); } catch { return []; } };
const downloaded = () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-code', 'current.json'), 'utf8')).file; } catch { return ''; } };

// Is a process running this very binary? Asked of the system, not of the app.
function runningFrom(file) {
  if (process.platform === 'linux') {
    let real = file; try { real = fs.realpathSync(file); } catch {}
    // A process keeps running a binary deleted under it, and Linux then names it "<path> (deleted)".
    return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).some((pid) => { try { return fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '') === real; } catch { return false; } });
  }
  if (process.platform === 'win32') {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='${path.basename(file)}'" | ForEach-Object { $_.ExecutablePath }`], { encoding: 'utf8' });
    return out.split(/\r?\n/).some((l) => l.trim().toLowerCase() === file.toLowerCase());
  }
  return execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8' }).split('\n').some((l) => l.trim() === file);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-claude-code-test-'));
  dataDir = path.join(tmp, 'data');
  fs.mkdirSync(path.join(tmp, 'project'));
  cc = await import('../lib/claude-code.mjs');
  own = cc.bundled();
  registry = await startFakeRegistry({ binary: own.file, key: own.key });
  api = await startFakeApi();
  app = await startApp({ port: await freePort(), dataDir, configDir: path.join(tmp, 'claude'), env: { ...fakeApiEnv(api), npm_config_registry: registry.url } });
});
after(async () => {
  await app?.stop(); await api?.close(); await registry?.close();
  // The Claude Code the app started may still be writing into its folders for a moment.
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
});

test('it runs the Claude Code the app came with, and says which', async () => {
  const s = (await call('/claude-code')).body;
  assert.equal(s.version, cc.bundledVersion());
  assert.equal(s.using, 'bundled');
  assert.equal(s.newer, false);
  assert.equal((await call('/version')).body.claudeCode.version, cc.bundledVersion());
});

test('Check now asks npm which Claude Code the newest SDK carries', async () => {
  const s = (await post('/claude-code/check')).body;
  assert.equal(s.latest, '2.1.999');
  assert.equal(s.sdk, '0.3.999');
  assert.equal(s.newer, true);
  assert.ok(registry.state.requests.includes('/@anthropic-ai/claude-agent-sdk/latest'));
});

test("a download that does not match npm's checksum is thrown away, and nothing changes", async () => {
  const good = registry.state.integrity;
  registry.state.integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
  try {
    assert.equal((await post('/claude-code/update')).status, 200);
    const s = await finished();
    assert.equal(s.job.phase, 'failed');
    assert.match(s.job.error, /checksum/);
    assert.equal(s.using, 'bundled');
    assert.equal(s.version, cc.bundledVersion());
    assert.ok(await until(() => folder().length === 0, 5000), 'no half-download left behind: ' + folder().join(', '));
  } finally { registry.state.integrity = good; }
});

test('the newer one is downloaded, checked, and every new Claude Code process runs it', async () => {
  assert.equal((await post('/claude-code/update')).status, 200);
  const s = await finished();
  assert.equal(s.job.phase, 'done', s.job.error);
  assert.equal(s.using, 'download');
  assert.equal(s.version, '2.1.999');
  assert.equal(s.newer, false);
  const file = downloaded();
  assert.ok(file && fs.existsSync(file), 'the binary is kept in the data folder');
  assert.equal(folder().length, 2, 'that binary and current.json, nothing else: ' + folder().join(', '));
  assert.equal((await post('/claude-code/update')).status, 400, 'nothing newer to take now');

  const asked = api.requests.length;
  const r = await post('/sessions', { text: 'Q1 hello', cwd: path.join(tmp, 'project'), cid: 'aaaaaaaa-0000-4000-8000-000000000001' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  app.session = r.body.sessionId;
  assert.ok(await until(() => api.requests.slice(asked).some((q) => q.path.endsWith('/v1/messages')), 60000), 'Claude Code asked the model');
  assert.ok(await until(() => runningFrom(file), 30000), 'the process is the downloaded binary');
});

test('going back to the one the app came with ends the resting process, and the next one is the app\'s own', async () => {
  const file = downloaded();
  const s = (await post('/claude-code/bundled')).body;
  assert.equal(s.using, 'bundled');
  assert.equal(s.version, cc.bundledVersion());
  assert.ok(!fs.existsSync(path.join(dataDir, 'claude-code', 'current.json')));
  assert.ok(fs.existsSync(file), 'the download stays while the server runs: a turn could still be running on it');
  assert.ok(await until(() => !runningFrom(file), 30000), 'the process resting on the download went');

  const asked = api.requests.length;
  const r = await post(`/sessions/${app.session}/send`, { text: 'Q2 again', cid: 'aaaaaaaa-0000-4000-8000-000000000002' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(await until(() => api.requests.slice(asked).some((q) => q.path.endsWith('/v1/messages')), 60000), 'Claude Code asked the model');
  assert.ok(await until(() => runningFrom(own.file), 30000), 'the next process is the app\'s own Claude Code');
});

test('the next start removes the download nothing uses any more', async () => {
  assert.notEqual(folder().length, 0);
  await app.stop();
  app = await startApp({ port: await freePort(), dataDir, configDir: path.join(tmp, 'claude'), env: { ...fakeApiEnv(api), npm_config_registry: registry.url } });
  assert.deepEqual(folder(), []);
  assert.equal((await call('/claude-code')).body.using, 'bundled');
});
