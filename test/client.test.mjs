// The client is one script in one function scope, and several features are written into it side by
// side. Two top-level functions with the same name do not fail anywhere: the later one silently
// replaces the earlier, and a feature stops working with no error. It happened - the Files pane's
// closeTab took over the Browser's, and × no longer closed a Browser tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('no top-level function in public/app.js is declared twice', () => {
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const seen = new Map(), twice = [];
  src.split('\n').forEach((line, i) => {
    const m = line.match(/^ {2}(?:async )?function ([\w$]+)\s*\(/); // the IIFE's own scope is two spaces in
    if (!m) return;
    if (seen.has(m[1])) twice.push(`${m[1]} (lines ${seen.get(m[1])} and ${i + 1})`);
    else seen.set(m[1], i + 1);
  });
  assert.deepEqual(twice, []);
});

// theme-desktop.css grows in versioned blocks appended at its end, and two blocks merged side by side
// once lost a closing brace: every rule after it was swallowed by an @media and simply did nothing.
test('every versioned block of theme-desktop.css starts with all braces closed', () => {
  const s = fs.readFileSync(new URL('../public/theme-desktop.css', import.meta.url), 'utf8');
  let depth = 0, inComment = false, line = 1;
  const open = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') { line++; if (depth !== 0 && /^\/\* ---------- v\d+/.test(s.slice(i + 1, i + 20))) open.push(line); }
    if (!inComment && c === '/' && s[i + 1] === '*') { inComment = true; i++; continue; }
    if (inComment && c === '*' && s[i + 1] === '/') { inComment = false; i++; continue; }
    if (inComment) continue;
    if (c === '{') depth++;
    if (c === '}') depth--;
  }
  assert.deepEqual({ depth, open }, { depth: 0, open: [] });
});
