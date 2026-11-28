// Which process listens on a port, and stopping it - the Servers card's Stop. The listener is
// found by port because that is all the card knows: a dev server may have been started by this
// app, by Claude in a terminal, or by hand. Only that process and what it started go; never
// anything by name.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(execFile);
const WIN = process.platform === 'win32';

/** `netstat -ano -p TCP` -> Map(port -> pid) of the listening sockets. First row wins when a port is bound twice (v4 and v6). */
// A server bound to one network card's address is not one a page on this computer reaches as localhost.
const LOOPBACK = /^(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]|\*|::|::1)$/;
export function parseNetstat(text, { loopbackOnly = false } = {}) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
    if (m && (!loopbackOnly || LOOPBACK.test(m[1])) && !out.has(Number(m[2]))) out.set(Number(m[2]), Number(m[3]));
  }
  return out;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -F pn` -> Map(port -> pid). Field output: a `p<pid>` line, then one `n<addr>:<port>` per socket. */
export function parseLsof(text, { loopbackOnly = false } = {}) {
  const out = new Map();
  let pid = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) { const m = /^n(.*):(\d+)$/.exec(line); if (m && (!loopbackOnly || LOOPBACK.test(m[1])) && !out.has(Number(m[2]))) out.set(Number(m[2]), pid); }
  }
  return out;
}

/** `ps -A -o pid=,ppid=` or `wmic`-style rows "pid ppid" -> Map(pid -> [child pids]). */
export function parseTree(text) {
  const kids = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) (kids.get(Number(m[2])) || kids.set(Number(m[2]), []).get(Number(m[2]))).push(Number(m[1]));
  }
  return kids;
}
/** pid and everything under it, leaves first - the order to stop them in. */
export function descendants(kids, pid) {
  const out = [];
  const walk = (p, seen) => { if (seen.has(p)) return; seen.add(p); for (const c of kids.get(p) || []) walk(c, seen); out.push(p); };
  walk(pid, new Set());
  return out;
}

export async function listeners({ loopbackOnly = false } = {}) {
  try {
    if (WIN) return parseNetstat((await execP('netstat', ['-ano', '-p', 'TCP'], { timeout: 8000, windowsHide: true, maxBuffer: 8 << 20 })).stdout, { loopbackOnly });
    return parseLsof((await execP('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'], { timeout: 8000, maxBuffer: 8 << 20 })).stdout, { loopbackOnly });
  } catch (e) {
    // lsof exits 1 when it finds nothing, with the (empty) answer on stdout.
    return e?.stdout ? parseLsof(e.stdout, { loopbackOnly }) : new Map();
  }
}
export const pidForPort = async (port) => (await listeners()).get(Number(port)) || 0;

/**
 * Stop the process listening on `port` and its children. `expectPid` is what the card showed:
 * a port that changed hands since then is left alone. `refuse` is the set of ports this app
 * itself listens on. Resolves { ok, pid } or { ok: false, error }.
 */
export async function stopPort(port, { expectPid = 0, refuse = new Set() } = {}) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, error: 'That is not a port a dev server would use.' };
  if (refuse.has(port)) return { ok: false, error: 'That is a port this app uses itself.' };
  const pid = await pidForPort(port);
  if (!pid) return { ok: false, error: 'Nothing is listening there any more.' };
  if (expectPid && pid !== expectPid) return { ok: false, error: 'Something else is on that port now. Look again.' };
  if (pid === process.pid || pid === process.ppid) return { ok: false, error: 'That is this app.' };
  try {
    if (WIN) await execP('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true });
    else {
      const kids = parseTree((await execP('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 8000 })).stdout);
      for (const p of descendants(kids, pid)) { try { process.kill(p, 'SIGTERM'); } catch {} }
    }
  } catch (e) { return { ok: false, error: String(e?.stderr || e?.message || e).trim().slice(0, 200) }; }
  for (let i = 0; i < 20; i++) { if ((await pidForPort(port)) !== pid) return { ok: true, pid }; await new Promise((r) => setTimeout(r, 150)); }
  return { ok: false, error: 'It did not stop.' };
}
