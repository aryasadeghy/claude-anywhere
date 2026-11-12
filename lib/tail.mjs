// Follow a session transcript that some other process (VS Code, a terminal,
// Claude Desktop) is writing, so the web client can watch it live. Claude Code
// appends one JSON line per finished block, so what we forward is exactly what
// the other window has already shown.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kindOf, toMessage } from './history.mjs';
import { cliProcessFor } from './cli-sessions.mjs';

export const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

const pathCache = new Map();
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function sessionFile(id) {
  // The id comes from a URL and becomes part of a path: one that is not a session id (an
  // encoded "..\" is one on Windows) names no file, rather than one outside the projects.
  if (!SESSION_ID.test(String(id))) return null;
  const cached = pathCache.get(id);
  if (cached && fs.existsSync(cached)) return cached;
  let root;
  try { root = fs.readdirSync(projectsDir(), { withFileTypes: true }); } catch { return null; }
  for (const d of root) {
    if (!d.isDirectory()) continue;
    const p = path.join(projectsDir(), d.name, id + '.jsonl');
    if (fs.existsSync(p)) { pathCache.set(id, p); return p; }
  }
  return null;
}

export const WORKING_WINDOW_MS = 45000;
export function lastWriteMs(id) {
  const f = sessionFile(id);
  try { return f ? fs.statSync(f).mtimeMs : 0; } catch { return 0; }
}
// `quietUntil`: writes up to this time (plus a little slack) were our own turn, not another window.
const working = (mtimeMs, quietUntil = 0) => mtimeMs > quietUntil + 3000 && Date.now() - mtimeMs < WORKING_WINDOW_MS;
// Or a Claude Code process that says it is busy on the session: a command running for minutes in
// another window writes nothing meanwhile (lib/cli-sessions.mjs).
export const isWorkingElsewhere = (id, quietUntil = 0) => working(lastWriteMs(id), quietUntil) || cliProcessFor(id)?.status === 'busy';

// Turn one transcript line into the same event shapes the live run stream uses. What history
// leaves out (meta lines, the CLI answering itself) is left out here too; a task's notice, a
// message typed mid-turn, a compaction or a notice arrives as a `row`, drawn as history draws it.
function toEvent(line, id) {
  const k = kindOf(line);
  if (!k) return line.type === 'mode' ? { t: 'mode', mode: line.mode } : null;
  const c = line.message?.content;
  if (k === 'a') return { t: 'assistant', uuid: line.uuid, content: c, tail: true };
  if (k === 'r') return { t: 'tool_results', uuid: line.uuid, content: c.filter((b) => b.type === 'tool_result') };
  if (k === 'u') {
    if (typeof c === 'string') return c ? { t: 'user_text', uuid: line.uuid, text: c } : null;
    const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
    const images = c.filter((b) => b.type === 'image');
    return text || images.length ? { t: 'user_text', uuid: line.uuid, text, images } : null;
  }
  return { t: 'row', m: toMessage(line, k, id) };
}

/** Start following `id` from its current end. Returns a stop() function, or null if the file is unknown. */
export function tailSession(id, onEvent, { quietUntil = 0 } = {}) {
  const file = sessionFile(id);
  if (!file) return null;
  let offset = 0;
  try { offset = fs.statSync(file).size; } catch {}
  let buf = '';
  let wasWorking = null;

  const read = () => {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    if (st.size < offset) { offset = 0; buf = ''; } // rewritten (e.g. compaction)
    if (st.size > offset) {
      const fd = fs.openSync(file, 'r');
      const chunk = Buffer.alloc(st.size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      fs.closeSync(fd);
      offset = st.size;
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        let parsed; try { parsed = JSON.parse(l); } catch { continue; }
        const ev = toEvent(parsed, id);
        if (ev) onEvent(ev);
      }
    }
    const now = working(st.mtimeMs, quietUntil) || cliProcessFor(id)?.status === 'busy';
    if (now !== wasWorking) { wasWorking = now; onEvent({ t: 'working', on: now }); }
  };

  read();
  // The file says when it changes: read at once, so a line written now reaches the page now and
  // not up to 800 ms later. Still look every second - for a change that was not reported, and to
  // notice the other window has gone quiet.
  let soon = null, watcher = null;
  try { watcher = fs.watch(file, () => { if (!soon) soon = setTimeout(() => { soon = null; read(); }, 25); }); watcher.on('error', () => {}); } catch {}
  const iv = setInterval(read, 1000);
  return () => { clearInterval(iv); clearTimeout(soon); try { watcher?.close(); } catch {} };
}
