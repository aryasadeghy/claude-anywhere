// The cron parser and scheduler math behind routines (lib/cron.mjs): no clock, no process, so
// this runs in milliseconds. `node --test test/cron.test.mjs` (not wired into `npm test` - the
// integrator does that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextRun, scheduleToCron, describeCron } from '../lib/cron.mjs';

test('parseCron: rejects anything that is not 5 fields', () => {
  assert.throws(() => parseCron('* * * *'), /5 fields/);
  assert.throws(() => parseCron('* * * * * *'), /5 fields/);
});

test('parseCron: ranges, lists and steps resolve to the values a human means', () => {
  const [min] = parseCron('0,15,30,45 * * * *');
  assert.deepEqual([...min].sort((a, b) => a - b), [0, 15, 30, 45]);
  const [, hr] = parseCron('0 9-17 * * *');
  assert.equal(hr.size, 9);
  const [, , , , dow] = parseCron('0 9 * * 1-5');
  assert.deepEqual([...dow].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  const [m2] = parseCron('*/15 * * * *');
  assert.deepEqual([...m2].sort((a, b) => a - b), [0, 15, 30, 45]);
});

test('parseCron: an out-of-range value is refused, not silently clamped', () => {
  assert.throws(() => parseCron('99 * * * *'));
  assert.throws(() => parseCron('* * * 13 *'));
});

test('nextRun: hourly lands on the next top of the hour', () => {
  const from = new Date(2026, 0, 5, 14, 23, 10);
  const n = nextRun('0 * * * *', from);
  assert.equal(n.getHours(), 15);
  assert.equal(n.getMinutes(), 0);
  assert.equal(n.getDate(), 5);
});

test('nextRun: daily at a time already passed today rolls to tomorrow', () => {
  const from = new Date(2026, 0, 5, 14, 23, 10);
  const n = nextRun('0 9 * * *', from);
  assert.equal(n.getDate(), 6);
  assert.equal(n.getHours(), 9);
  assert.equal(n.getMinutes(), 0);
});

test('nextRun: daily at a time still ahead today stays on today', () => {
  const from = new Date(2026, 0, 5, 8, 0, 0);
  const n = nextRun('0 9 * * *', from);
  assert.equal(n.getDate(), 5);
  assert.equal(n.getHours(), 9);
});

test('nextRun: weekdays-only skips the weekend', () => {
  // 2026-01-09 is a Friday.
  const from = new Date(2026, 0, 9, 10, 0, 0);
  const n = nextRun('0 9 * * 1-5', from);
  assert.equal(n.getDay(), 1); // Monday
  assert.equal(n.getDate(), 12);
});

test('nextRun: weekly on a chosen day finds that day next week when today is past it', () => {
  // 2026-01-07 is a Wednesday; weekly on Monday (1) should land on 2026-01-12.
  const from = new Date(2026, 0, 7, 10, 0, 0);
  const n = nextRun('0 9 * * 1', from);
  assert.equal(n.getDay(), 1);
  assert.equal(n.getFullYear(), 2026);
  assert.equal(n.getMonth(), 0);
  assert.equal(n.getDate(), 12);
});

test('nextRun: an impossible day (Feb 30) never matches and returns null', () => {
  assert.equal(nextRun('0 0 30 2 *', new Date(2026, 0, 1)), null);
});

test('scheduleToCron: each descriptor maps to the cron a human would write', () => {
  assert.equal(scheduleToCron({ type: 'hourly' }), '0 * * * *');
  assert.equal(scheduleToCron({ type: 'daily', time: '09:30' }), '30 9 * * *');
  assert.equal(scheduleToCron({ type: 'weekdays', time: '08:00' }), '0 8 * * 1-5');
  assert.equal(scheduleToCron({ type: 'weekly', day: 3, time: '17:15' }), '15 17 * * 3');
  assert.equal(scheduleToCron({ type: 'custom', cron: '*/5 * * * *' }), '*/5 * * * *');
});

test('scheduleToCron: a custom cron that does not parse is rejected up front, not at run time', () => {
  assert.throws(() => scheduleToCron({ type: 'custom', cron: 'nonsense' }));
});

test('describeCron: the four built-in shapes read back in plain words', () => {
  assert.equal(describeCron('0 * * * *'), 'Every hour');
  assert.equal(describeCron('30 9 * * *'), 'Daily at 9:30 AM');
  assert.equal(describeCron('0 8 * * 1-5'), 'Weekdays at 8:00 AM');
  assert.equal(describeCron('15 17 * * 3'), 'Weekly on Wednesday at 5:15 PM');
  assert.equal(describeCron('*/5 * * * *'), 'Custom: */5 * * * *');
});
