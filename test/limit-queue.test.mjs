// Messages typed after the plan's usage limit is reached wait above the composer instead of
// failing, and go in by themselves once the limit resets (lib/limit-queue.mjs). The part worth a
// test on its own, without a live Claude Code: that these survive a restart - a 5-hour or weekly
// reset routinely outlives both the resting process (KEEP_WARM_MS) and this server itself, so the
// held queue has to be read back from disk, not only kept in memory.
// `node --test test/limit-queue.test.mjs` (not wired into `npm test` - the integrator does that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-limit-queue-test-'));
const dataDir = path.join(tmp, 'data');
const SID = 'dddddddd-1111-2222-3333-444444444444';

test('hold, list, edit and remove a held message', async () => {
  const lq = await import('../lib/limit-queue.mjs');
  lq.init(dataDir);
  assert.deepEqual(lq.list(SID), []);
  const row = lq.hold(SID, { text: 'finish the report', images: [], cwd: 'C:/tmp' });
  assert.equal(lq.list(SID).length, 1);
  assert.equal(lq.list(SID)[0].text, 'finish the report');
  assert.ok(row.id);

  const edited = lq.edit(SID, row.id, 'finish the report and the summary');
  assert.equal(edited.text, 'finish the report and the summary');
  assert.equal(lq.list(SID)[0].text, 'finish the report and the summary');
  assert.equal(lq.edit(SID, 'no-such-id', 'x'), null);

  assert.equal(lq.remove(SID, 'no-such-id'), false);
  assert.equal(lq.remove(SID, row.id), true);
  assert.deepEqual(lq.list(SID), []);
});

test('held messages survive a restart (read back from dataDir on the next init)', async () => {
  const lq = await import('../lib/limit-queue.mjs?case=restart'); // a fresh module instance, like a fresh process
  lq.init(dataDir);
  lq.hold(SID, { text: 'message one', cwd: 'C:/tmp' });
  lq.hold(SID, { text: 'message two', cwd: 'C:/tmp' });
  assert.equal(lq.list(SID).length, 2);

  // What a restart actually does: read the same file back into a clean module.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'limit-queue.json'), 'utf8'));
  assert.equal(onDisk[SID].length, 2);
  const lq2 = await import('../lib/limit-queue.mjs?case=restart2');
  lq2.init(dataDir);
  assert.equal(lq2.list(SID).length, 2);
  assert.deepEqual(lq2.list(SID).map((x) => x.text), ['message one', 'message two']);
});

test('currentLimit() answers null with no plan limits known yet', async () => {
  const lq = await import('../lib/limit-queue.mjs?case=nolimit');
  lq.init(path.join(tmp, 'data2'));
  assert.equal(lq.currentLimit(), null);
});

console.log('(limit-queue.test.mjs does not cover currentLimit() detecting an actual hit: that');
console.log(' reads lib/runs.mjs\'s lastLimits, set from a live Query\'s usage call or a');
console.log(' rate_limit_event message - neither reproducible without a real plan limit or a');
console.log(' fake CLI protocol double, which is out of scope here; reviewed by hand instead.)');
