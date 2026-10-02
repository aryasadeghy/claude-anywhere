// The Browser pane's server side, end to end: the real app and a dev server built to break
// the old /preview/<port>/ proxy, talking over real sockets. No browser needed - that is
// test/ui/browser.cjs - and nothing to install: `node --test test/`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, startDevServer, makeProject, startApp } from './fixtures/index.mjs';

let tmp, dev, app, key, filesPort, devOrigin, project;
const auth = () => ({ authorization: 'Bearer ' + app.token });
const withKey = (extra = {}) => ({ cookie: 'ca_preview=' + key, ...extra });
const at = (port, p = '/') => `http://127.0.0.1:${port}${p}`;
const filePath = (p) => '/' + p.replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent).join('/');

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-browser-test-'));
  project = makeProject(path.join(tmp, 'project'));
  dev = await startDevServer();
  app = await startApp({ port: await freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude') });
  const res = await fetch(app.base + '/api/preview/grant', { headers: auth() });
  const body = await res.json();
  key = body.key; filesPort = body.files;
  app.cookie = res.headers.getSetCookie().join('\n');
  devOrigin = (await (await fetch(app.base + '/api/preview/origin?port=' + dev.port, { headers: auth() })).json()).port;
});
after(async () => {
  await app?.stop(); await dev?.close();
  // The Claude Code the app starts for its model list outlives a killed app by a moment and
  // is still writing into the config folder (ENOTEMPTY on Linux CI, as in history.test.mjs):
  // retry, and never fail a run over a temp folder.
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
});

test('the frames ride on a preview key of their own, never the sign-in token', () => {
  assert.match(key, /^[A-Za-z0-9_-]{24,}$/);
  assert.notEqual(key, app.token);
  assert.match(app.cookie, new RegExp(`ca_preview=${key}; Path=/; HttpOnly; SameSite=Lax`));
  assert.ok(!app.cookie.includes(app.token), 'the sign-in token must not be in any cookie');
});

test('a dev server is shown at the root of a port of its own, and only with the key', async () => {
  assert.ok(Number.isInteger(devOrigin) && devOrigin !== dev.port);
  assert.equal((await fetch(at(devOrigin))).status, 401);
  const res = await fetch(at(devOrigin, '/about'), { headers: withKey() });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /caBrowser/, 'the bridge is in the page');
  assert.match(html, /src="\/assets\/app\.js"/, 'the page is not rewritten: its own paths are right as they are');
  assert.equal(res.headers.get('x-frame-options'), null, 'frame-busting is dropped');
  assert.equal(res.headers.get('content-security-policy'), null);
});

test('the dev server is asked exactly what the page asked, as itself, without the app\'s key', async () => {
  const seen = await (await fetch(at(devOrigin, '/api/echo?x=1'), { headers: withKey({ cookie: `ca_preview=${key}; theirs=1`, origin: at(devOrigin).replace(/\/$/, '') }) })).json();
  assert.equal(seen.url, '/api/echo?x=1', 'no /preview/<port> prefix for the router to trip on');
  assert.equal(seen.host, '127.0.0.1:' + dev.port, 'Vite refuses a Host it does not know');
  assert.equal(seen.origin, 'http://127.0.0.1:' + dev.port);
  assert.equal(seen.cookie, 'theirs=1', 'the page\'s own cookies pass, the app\'s key does not');
});

test('a sign-in cookie for localhost, https only, is loosened so the frame keeps it', async () => {
  const res = await fetch(at(devOrigin, '/api/login'), { method: 'POST', headers: withKey() });
  assert.deepEqual(res.headers.getSetCookie(), ['sess=ok; Path=/; HttpOnly; SameSite=Lax']);
});

test('a redirect to the dev server\'s own address stays in the pane', async () => {
  const res = await fetch(at(devOrigin, '/go'), { headers: withKey(), redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/about');
});

// A socket by hand: the upgrade, then the dev server's first message, which it writes in
// the same packet as its 101. The old proxy pushed those bytes back to the dev server.
function firstMessage(port, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', cookie: 'ca_preview=' + key } });
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { req.destroy(); done(null); }, 3000);
    req.on('upgrade', (res, socket, head) => {
      const read = (b) => { socket.destroy(); done(b.slice(2, 2 + b[1]).toString()); };
      if (head.length) read(head); else socket.once('data', read);
    });
    req.on('response', (res) => { res.resume(); done('no upgrade: ' + res.statusCode); });
    req.on('error', () => done(null));
    req.end();
  });
}
test('the dev server\'s first hot-reload message reaches the page, at its own origin and through /preview/', async () => {
  for (const [port, p] of [[devOrigin, '/hmr'], [Number(new URL(app.base).port), `/preview/${dev.port}/hmr`]]) {
    for (let i = 0; i < 20; i++) assert.equal(await firstMessage(port, p), 'live', `socket ${i + 1} on ${p}`);
  }
});

test('a project\'s page is served with its own CSS, picture and PDF, and the bridge', async () => {
  assert.ok(filesPort > 0);
  const base = at(filesPort, filePath(project.site));
  const page = await fetch(base + '/index.html', { headers: withKey() });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /caBrowser/);
  assert.match(html, /<title>Quarterly report<\/title>/);
  for (const [f, type] of [['style.css', /text\/css/], ['chart.svg', /image\/svg\+xml/], ['report.pdf', /application\/pdf/]]) {
    const r = await fetch(`${base}/${f}`, { headers: withKey() });
    assert.equal(r.status, 200, f);
    assert.match(r.headers.get('content-type'), type, f);
  }
  const part = await fetch(base + '/report.pdf', { headers: withKey({ range: 'bytes=0-99' }) });
  assert.equal(part.status, 206, 'a PDF viewer reads in ranges');
  const folder = await fetch(base, { headers: withKey(), redirect: 'manual' });
  assert.equal(folder.status, 302, 'a folder gets its slash, so the page\'s links resolve inside it');
  assert.equal((await fetch(base + '/index.html')).status, 401, 'nothing without the key');
});

test('files outside the project folders are refused, however the path is spelled', async () => {
  const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hostname';
  assert.equal((await fetch(at(filesPort, filePath(outside)), { headers: withKey() })).status, 403);
  const up = at(filesPort, filePath(project.site) + '/..%2F..%2F..%2F..%2F..%2F..%2F..%2F..%2Fetc%2Fhostname');
  assert.equal((await fetch(up, { headers: withKey() })).status, 403);
});

test('behind one https port, the fallback serves the same files sandboxed, under the key', async () => {
  const r = await fetch(app.base + '/files/' + key + filePath(project.site) + '/index.html');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy') || '', /^sandbox allow-scripts/, 'on the app\'s origin a page gets no origin of its own');
  assert.equal((await fetch(app.base + '/files/' + 'A'.repeat(32) + filePath(project.site) + '/index.html')).status, 401);
});

test('"Open in your browser" hands the key over on the way in, and goes nowhere else', async () => {
  const to = filePath(project.site) + '/index.html';
  const ok = await fetch(at(filesPort, `/__claude-anywhere/enter?key=${key}&to=${encodeURIComponent(to)}`), { redirect: 'manual' });
  assert.equal(ok.status, 302);
  assert.match(ok.headers.getSetCookie()[0], new RegExp(`^ca_preview=${key};.*HttpOnly`));
  assert.equal(decodeURIComponent(ok.headers.get('location')), decodeURIComponent(to));
  assert.equal((await fetch(at(filesPort, '/__claude-anywhere/enter?key=nope&to=/'), { redirect: 'manual' })).status, 401);
  assert.equal((await fetch(at(filesPort, `/__claude-anywhere/enter?key=${key}&to=//example.com`), { redirect: 'manual' })).status, 401);
});

test('with remote access off, anything arriving through a proxy is turned away', async () => {
  const forwarded = withKey({ 'x-forwarded-for': '203.0.113.9' });
  assert.equal((await fetch(at(devOrigin), { headers: forwarded })).status, 403);
  assert.equal((await fetch(at(filesPort, filePath(project.site) + '/index.html'), { headers: forwarded })).status, 403);
});

test('the app cannot be asked to preview itself', async () => {
  const port = Number(new URL(app.base).port);
  for (const p of [port, filesPort, devOrigin]) assert.equal((await fetch(app.base + '/api/preview/origin?port=' + p, { headers: auth() })).status, 400, 'port ' + p);
});
