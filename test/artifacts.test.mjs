import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as a from '../lib/artifacts.mjs';

const SID = '11111111-2222-3333-4444-555555555555';
const fresh = () => { a.configure(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-art-'))); };

test('create, list and read an artifact', () => {
  fresh();
  const m = a.create(SID, { title: 'Pricing page', type: 'html', content: '<h1>Hi</h1>' });
  assert.equal(m.id, 'pricing-page'); assert.equal(m.version, 1);
  assert.equal(a.list(SID).length, 1);
  assert.equal(a.get(SID, 'pricing-page').content, '<h1>Hi</h1>');
  assert.throws(() => a.create(SID, { title: 'Pricing page', type: 'html', content: 'x' }), /already exists/);
  assert.throws(() => a.create(SID, { title: 'x', type: 'pdf', content: 'x' }), /type must be/);
});

test('every version is kept; a find/replace edit makes a new one', () => {
  fresh();
  a.create(SID, { id: 'p', title: 'P', type: 'html', content: '<p>one two two</p>' });
  assert.equal(a.update(SID, 'p', { find: 'one', replace: 'uno' }).version, 2);
  assert.throws(() => a.update(SID, 'p', { find: 'two', replace: 'x' }), /2 times/);
  assert.throws(() => a.update(SID, 'p', { find: 'nope', replace: 'x' }), /not in the artifact/);
  a.update(SID, 'p', { find: 'two', replace: 'dos', all: true });
  a.update(SID, 'p', { content: '<p>new</p>', note: 'Rewrote it' });
  const g = a.get(SID, 'p');
  assert.equal(g.version, 4); assert.equal(g.content, '<p>new</p>'); assert.equal(g.versions[3].note, 'Rewrote it');
  assert.equal(a.get(SID, 'p', 1).content, '<p>one two two</p>');
  assert.equal(a.get(SID, 'p', 2).content, '<p>uno two two</p>');
  assert.equal(a.get(SID, 'p', 3).content, '<p>uno dos dos</p>');
});

test('ids cannot escape the folder', () => {
  fresh();
  assert.throws(() => a.get('../etc', 'x'), /bad session id/);
  assert.throws(() => a.get(SID, '../../x'), /bad artifact id/);
});

test('a share link shows the latest version, and stops working when revoked or deleted', () => {
  fresh();
  a.create(SID, { id: 'p', title: 'P', type: 'svg', content: '<svg/>' });
  const t = a.share(SID, 'p');
  assert.ok(t.length >= 20); assert.equal(a.share(SID, 'p'), t);
  assert.equal(a.byShare(t).content, '<svg/>');
  a.update(SID, 'p', { content: '<svg id="2"/>' });
  assert.equal(a.byShare(t).content, '<svg id="2"/>');
  assert.equal(a.byShare('x'.repeat(24)), null);
  a.unshare(SID, 'p'); assert.equal(a.byShare(t), null);
  const t2 = a.share(SID, 'p'); assert.notEqual(t2, t);
  a.remove(SID, 'p'); assert.equal(a.byShare(t2), null); assert.equal(a.list(SID).length, 0);
});

test('pages: html is kept, a fragment gets a shell, content cannot close the script around it', () => {
  const whole = '<!doctype html><title>x</title><b>y</b>';
  assert.equal(a.renderPage('html', whole), whole);
  assert.match(a.renderPage('html', '<b>y</b>'), /<body><b>y<\/b>/);
  const md = a.renderPage('markdown', '</script><img src=x onerror=alert(1)>');
  assert.ok(!md.includes('</script><img'));
  assert.match(a.renderPage('code', '<b>&'), /&lt;b&gt;&amp;/);
  assert.match(a.renderPage('mermaid', 'graph TD; A-->B'), /mermaid/);
});

test('react: imports become globals and the default export is what renders', () => {
  const src = a.reactSource("import React, { useState } from 'react';\nexport default function App() { const [n] = useState(0); return <b>{n}</b>; }");
  assert.match(src, /const \{ useState \} = React;/);
  assert.match(src, /function App\(\)/); assert.ok(!/export/.test(src)); assert.match(src, /return App;/);
  assert.match(a.reactSource("import x from 'lodash';\nexport default () => 1;"), /Not available in an artifact/);
  assert.match(a.reactSource('export default () => <i/>;'), /const __Default = /);
});
