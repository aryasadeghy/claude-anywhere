// Which sessions have a Claude Code process alive right now, from Claude Code's own record of them:
// one <config>/sessions/<pid>.json per running process, with its sessionId and whether it is busy.
// That covers Desktop, VS Code and a terminal as much as this app. Guessing from the transcript
// alone - nothing written for 45 seconds and an unfinished tool call - called a long test run in
// another window "stopped", and offered to start a second Claude Code on the same conversation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
let cache = { at: 0, bySession: new Map() };

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function read() {
  const bySession = new Map();
  let names = []; try { names = fs.readdirSync(DIR()).filter((n) => /^\d+\.json$/.test(n)); } catch {}
  for (const n of names) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(DIR(), n), 'utf8')); } catch { continue; }
    if (!j?.sessionId || !Number.isInteger(j.pid) || !alive(j.pid)) continue;
    const prev = bySession.get(j.sessionId);
    if (!prev || j.status === 'busy') bySession.set(j.sessionId, { pid: j.pid, status: j.status || '', entrypoint: j.entrypoint || '' });
  }
  return bySession;
}

/** The live Claude Code process for a session, or null. Read at most every two seconds. */
export function cliProcessFor(sessionId) {
  if (Date.now() - cache.at > 2000) cache = { at: Date.now(), bySession: read() };
  return cache.bySession.get(sessionId) || null;
}
