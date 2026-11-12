// What kept taking the server down, or told the person a turn had stopped when it had not:
// - an untracked file in the Changes panel was read whole, gigabytes of crawl output included, and
//   copied line by line until the server ran out of memory with every running turn in it;
// - "This turn stopped in the middle of a tool call" was decided from the transcript alone, so a
//   long command in another window (writing nothing for minutes) read as a stopped turn, with a
//   Continue that would start a second Claude Code beside the one still working.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { freePort, makeSession, startApp } from './fixtures/index.mjs';

let tmp, app, configDir, repo, file;
const SID = 'efefefef-1111-2222-3333-444444444444';
const api = (p) => fetch(app.base + '/api' + p, { headers: { authorization: 'Bearer ' + app.token } }).then((r) => r.json());

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-stays-up-'));
  configDir = path.join(tmp, 'claude');
  repo = path.join(tmp, 'repo'); fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  // 6 MB of untracked text: the panel must show the start of it, not read it all.
  fs.writeFileSync(path.join(repo, 'crawl.jsonl'), ('{"url":"https://example.com/page","status":200}\n').repeat(130000));
  makeSession(configDir, repo, SID);
  // The session's last line is an unfinished tool call, written two minutes ago.
  file = path.join(configDir, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'), SID + '.jsonl');
  const at = new Date(Date.now() - 120000).toISOString();
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: SID + '-tool', timestamp: at, cwd: repo, sessionId: SID, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: 'npm test' } }] } }) + '\n');
  const then = new Date(Date.now() - 120000); fs.utimesSync(file, then, then);
  app = await startApp({ port: await freePort(), dataDir: path.join(tmp, 'data'), configDir });
});
after(async () => { await app?.stop(); try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} });

test('a huge untracked file shows its start in the Changes panel, truncated', async () => {
  const d = await api(`/sessions/${SID}/changes/diff?path=crawl.jsonl`);
  assert.equal(d.truncated, true);
  assert.ok(d.diff.length < 2 * 1024 * 1024, 'the answer is the start of the file, not all of it');
  assert.match(d.diff.split('\n')[3], /^\+\{"url"/);
});

test('an unfinished tool call with no Claude Code alive reads as stopped', async () => {
  const s = await api(`/sessions/${SID}`);
  assert.equal(s.interrupted?.kind, 'tool_call');
});

test('...but not while a Claude Code process says it has the session', async () => {
  // Claude Code's own record of a running process: <config>/sessions/<pid>.json.
  const dir = path.join(configDir, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  const rec = path.join(dir, process.pid + '.json');
  fs.writeFileSync(rec, JSON.stringify({ pid: process.pid, sessionId: SID, status: 'busy', entrypoint: 'claude-desktop' }));
  await new Promise((r) => setTimeout(r, 2200)); // the record is read at most every two seconds
  try {
    const s = await api(`/sessions/${SID}`);
    assert.equal(s.interrupted, null);
    assert.equal(s.working, true);
  } finally { fs.rmSync(rec, { force: true }); }
});
