// stripAnsi is what turns a tab's raw scrollback into words Claude or the next message can
// read: escapes gone, a redrawn line (progress bars, "\r" with no "\n") collapsed to what it
// last said. Pure function, no server or shell needed - milliseconds, not a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi } from '../lib/terminal.mjs';

test('drops colour and cursor escapes, keeps the text', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m plain'), 'red plain');
  assert.equal(stripAnsi('\x1b[2J\x1b[Hcleared'), 'cleared');
});

test('drops OSC sequences (title, and the shell-integration marker) without eating neighbours', () => {
  assert.equal(stripAnsi('before\x1b]0;a title\x07after'), 'beforeafter');
  assert.equal(stripAnsi('PS C:\\> \x1b]7001;0\x07next'), 'PS C:\\> next');
});

test('a redrawn line ("\\r" with no "\\n") keeps only what was last written to it', () => {
  assert.equal(stripAnsi('Downloading... 10%\rDownloading... 100%'), 'Downloading... 100%');
  // across real lines, each keeps its own last redraw
  assert.equal(stripAnsi('a\rA\nb\rB\n'), 'A\nB\n');
});

test('plain text with nothing to strip passes through unchanged', () => {
  assert.equal(stripAnsi('hello-ca-terminal\n'), 'hello-ca-terminal\n');
});
