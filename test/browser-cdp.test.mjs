// The real browser's plumbing (lib/browser.mjs): the pipe's framing, what an address is in the
// pane's terms, what Claude may open without asking - and, where this computer has Chrome or
// Edge, one real tab end to end. `node --test test/browser-cdp.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as browser from '../lib/browser.mjs';

test('a message split anywhere, even inside a character, comes out whole', () => {
  const got = [];
  const feed = browser.pipeFramer((m) => got.push(m));
  const wire = Buffer.concat([browser.encodeCommand({ id: 1, method: 'A', params: { s: 'héllo ✓ 日本' } }), browser.encodeCommand({ id: 2, result: {} })]);
  // One byte at a time: every split point, including the middle of each multi-byte character.
  for (let i = 0; i < wire.length; i++) feed(wire.subarray(i, i + 1));
  assert.deepEqual(got, [{ id: 1, method: 'A', params: { s: 'héllo ✓ 日本' } }, { id: 2, result: {} }]);
});

test('several messages in one chunk, and a bad one between them, are read in order', () => {
  const got = [];
  const feed = browser.pipeFramer((m) => got.push(m.id));
  feed(Buffer.concat([browser.encodeCommand({ id: 1 }), Buffer.from('{not json\0'), browser.encodeCommand({ id: 2 }), Buffer.from('{"id":3')]));
  assert.deepEqual(got, [1, 2]);
  feed(Buffer.from('}\0'));
  assert.deepEqual(got, [1, 2, 3]);
});

test('an address is a server, a project file, the web or nothing', () => {
  browser.configure({ filesPrefix: 'http://127.0.0.1:7777/files/', fileKey: () => 'k'.repeat(24) });
  assert.deepEqual(browser.specOf('http://localhost:5173/a?b#c'), { kind: 'server', port: 5173, path: '/a?b#c' });
  assert.deepEqual(browser.specOf('http://127.0.0.1:8080/'), { kind: 'server', port: 8080, path: '/' });
  assert.deepEqual(browser.specOf('https://example.com/x'), { kind: 'web', url: 'https://example.com/x' });
  assert.deepEqual(browser.specOf('about:blank'), { kind: 'blank' });
  const u = browser.urlOf({ kind: 'file', file: 'C:\\proj\\site\\my page.html' });
  assert.equal(u, 'http://127.0.0.1:7777/files/' + 'k'.repeat(24) + '/C%3A/proj/site/my%20page.html');
  assert.deepEqual(browser.specOf(u), { kind: 'file', file: 'C:\\proj\\site\\my page.html' });
  assert.equal(browser.urlOf({ kind: 'server', port: 3000, path: '/x' }), 'http://localhost:3000/x');
  assert.equal(browser.urlOf({ kind: 'web', url: 'javascript:alert(1)' }), 'about:blank');
});

test('only this computer\'s own pages count as local', () => {
  for (const u of ['http://localhost:5173/', 'localhost:3000', '127.0.0.1:8080/x', 'http://[::1]:4000', '5173/settings', 'about:blank', 'http://app.localhost:3000']) assert.equal(browser.isLocalUrl(u), true, u);
  for (const u of ['https://example.com', 'example.com', 'http://localhost.evil.com', 'http://192.168.1.4:3000', 'file:///C:/x', 'javascript:1']) assert.equal(browser.isLocalUrl(u), false, u);
});

test('a real tab: opens, loads, reads, clicks, screenshots, and the browser closes', { skip: !browser.available() && 'no Chrome or Edge here', timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-cdp-'));
  browser.configure({ dataDir: dir });
  try {
    const page = 'data:text/html,' + encodeURIComponent('<title>T</title><input id=i><button id=b onclick="document.title=\'clicked \'+document.getElementById(\'i\').value">Go</button>');
    const tab = await browser.newTab('test', page);
    await browser.settle(tab);
    const snap = await browser.snapshot(tab);
    assert.match(snap, /button "Go" \[ref=e\d+\]/);
    await browser.fill(tab, { selector: '#i' }, 'hi');
    const ref = /button "Go" \[ref=(e\d+)\]/.exec(snap)[1];
    await browser.click(tab, { ref });
    assert.equal(await browser.evaluate(tab, 'document.title'), 'clicked hi');
    const jpg = Buffer.from(await browser.screenshot(tab, { scale: 0.5 }), 'base64');
    assert.equal(jpg[0], 0xff); assert.equal(jpg[1], 0xd8);
    const pid = browser.pid();
    await browser.shutdown();
    assert.equal(browser.running(), false);
    // Gone, not just let go of.
    let alive = true;
    for (let i = 0; i < 60 && alive; i++) { try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { alive = false; } }
    assert.equal(alive, false, 'the browser process is still there');
  } finally { await browser.shutdown(); }
});
