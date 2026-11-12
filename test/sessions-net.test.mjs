// Pure logic in lib/sessions-net.mjs: the parent/child link a nested session leaves behind, the
// "Received N messages" counter, and the sidebar's user-made sections. No live Claude Code needed.
// `node --test test/sessions-net.test.mjs` (not wired into `npm test` - the integrator does that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-sessions-net-test-'));
process.env.CLAUDE_ANYWHERE_DATA_DIR = path.join(tmp, 'data');

const net = await import('../lib/sessions-net.mjs');

test('a nested session links back to its parent and shows up as a child', () => {
  net.linkChild('child-1', { parentId: 'parent-1', parentTitle: 'Plan the trip', prompt: 'List 5 coast towns', title: 'Coast towns' });
  const link = net.linkFor('child-1');
  assert.equal(link.parentId, 'parent-1');
  assert.equal(link.title, 'Coast towns');
  assert.equal(net.childrenOf('parent-1').length, 1);
  assert.equal(net.childrenOf('parent-1')[0].id, 'child-1');
});

test('dismissing a task removes it from the parent\'s live children', () => {
  net.linkChild('child-2', { parentId: 'parent-1', title: 'Second task' });
  assert.equal(net.dismiss('child-2'), true);
  assert.equal(net.dismiss('no-such-id'), false);
  const link = net.linkFor('child-2');
  assert.equal(link.dismissed, true);
});

test('received-message counter accumulates and clears', () => {
  assert.equal(net.noteReceived('parent-1', 1), 1);
  assert.equal(net.noteReceived('parent-1', 1), 2);
  net.clearReceived('parent-1');
  assert.equal(net.noteReceived('parent-1', 0), 0);
});

test('sidebar sections: create, rename, move a session in, delete', () => {
  const sec = net.createSection('Billing work');
  assert.equal(sec.name, 'Billing work');
  assert.equal(net.listSections().some((s) => s.id === sec.id), true);

  net.moveToSection('session-a', sec.id);
  assert.deepEqual(net.listSections().find((s) => s.id === sec.id).sessionIds, ['session-a']);

  assert.equal(net.renameSection(sec.id, 'Billing & invoices'), true);
  assert.equal(net.listSections().find((s) => s.id === sec.id).name, 'Billing & invoices');

  assert.equal(net.deleteSection(sec.id), true);
  assert.equal(net.listSections().some((s) => s.id === sec.id), false);
  assert.equal(net.renameSection('no-such-id', 'x'), false);
});

test('sidebar prefs persist and merge', () => {
  assert.deepEqual(net.getSidebarPrefs(), { groupBy: 'none', sortBy: 'recent', showEmptyGroups: false });
  net.setSidebarPrefs({ groupBy: 'project' });
  assert.deepEqual(net.getSidebarPrefs(), { groupBy: 'project', sortBy: 'recent', showEmptyGroups: false });
});
